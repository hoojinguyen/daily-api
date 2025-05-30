import { FastifyInstance } from 'fastify';
import {
  EventName,
  TransactionCompletedEvent,
  TransactionCreatedEvent,
  type EventEntity,
  type SubscriptionCanceledEvent,
  type SubscriptionUpdatedEvent,
  type TransactionPaymentFailedEvent,
  type TransactionUpdatedEvent,
  type TransactionPayoutTotalsNotification,
  type TransactionPaidEvent,
} from '@paddle/paddle-node-sdk';
import createOrGetConnection from '../../db';
import {
  concatTextToNewline,
  isProd,
  updateFlagsStatement,
  updateSubscriptionFlags,
  webhooks,
} from '../../common';
import {
  SubscriptionProvider,
  User,
  UserSubscriptionStatus,
} from '../../entity';
import { logger } from '../../logger';
import {
  AnalyticsEventName,
  sendAnalyticsEvent,
  TargetType,
} from '../../integrations/analytics';
import { JsonContains, type DataSource, type EntityManager } from 'typeorm';
import {
  dropClaimableItem,
  extractSubscriptionCycle,
  getPaddleTransactionData,
  getTransactionForProviderId,
  updateClaimableItem,
  isCoreTransaction,
  paddleInstance,
} from '../../common/paddle';
import { addMilliseconds } from 'date-fns';
import {
  isPlusMember,
  plusGiftDuration,
  SubscriptionCycles,
  type PaddleSubscriptionEvent,
} from '../../paddle';
import {
  UserTransaction,
  UserTransactionProcessor,
  UserTransactionStatus,
} from '../../entity/user/UserTransaction';
import { purchaseCores, UserTransactionError } from '../../common/njord';
import { checkUserCoresAccess } from '../../common/user';
import { CoresRole } from '../../types';
import { TransferError } from '../../errors';
import { remoteConfig } from '../../remoteConfig';

export interface PaddleCustomData {
  user_id?: string;
  gifter_id?: string;
}

export const updateUserSubscription = async ({
  event,
  state,
}: {
  event: PaddleSubscriptionEvent | undefined;
  state: boolean;
}) => {
  if (!event) {
    return;
  }

  const { data } = event;
  const customData: PaddleCustomData = data?.customData ?? {};

  const con = await createOrGetConnection();
  const userId = customData?.user_id;

  const subscriptionType = extractSubscriptionCycle(data.items);

  if (!subscriptionType) {
    logger.error(
      {
        provider: SubscriptionProvider.Paddle,
        data: event,
      },
      'Subscription type missing in payload',
    );
    return false;
  }
  if (!userId) {
    if (state) {
      await updateClaimableItem(con, data);
    } else {
      await dropClaimableItem(con, data);
    }
  } else {
    const user = await con.getRepository(User).findOneBy({ id: userId });
    if (!user) {
      logger.error(
        { provider: SubscriptionProvider.Paddle, data: event },
        'User not found',
      );
      return false;
    }

    if (
      user.subscriptionFlags?.provider === SubscriptionProvider.AppleStoreKit
    ) {
      logger.error(
        {
          user,
          data: event,
          provider: SubscriptionProvider.Paddle,
        },
        'User already has a Apple subscription',
      );
      throw new Error('User already has a StoreKit subscription');
    }

    await con.getRepository(User).update(
      {
        id: userId,
      },
      {
        subscriptionFlags: updateSubscriptionFlags({
          cycle: state ? subscriptionType : null,
          createdAt: state ? data?.startedAt : null,
          subscriptionId: state ? data?.id : null,
          provider: state ? SubscriptionProvider.Paddle : null,
          status: state ? UserSubscriptionStatus.Active : null,
        }),
      },
    );
  }
};

const getUserId = async ({
  subscriptionId,
  userId,
}: {
  subscriptionId?: false | string | null;
  userId?: string | undefined;
}): Promise<string> => {
  if (userId) {
    return userId;
  }

  const con = await createOrGetConnection();
  const user = await con.getRepository(User).findOne({
    where: { subscriptionFlags: JsonContains({ subscriptionId }) },
    select: ['id'],
  });

  if (!user) {
    // for anonymouse subs this will be empty
    return '';
  }

  return user.id;
};

// will always return false for anonymous subscriptions
const planChanged = async ({ data }: SubscriptionUpdatedEvent) => {
  const customData = data?.customData as { user_id: string };
  const userId = await getUserId({
    userId: customData?.user_id,
    subscriptionId: data?.id,
  });
  const con = await createOrGetConnection();
  const flags = await con.getRepository(User).findOne({
    where: { id: userId },
    select: ['subscriptionFlags'],
  });

  return (
    (flags?.subscriptionFlags?.cycle as string) !==
    extractSubscriptionCycle(data?.items)
  );
};

interface AnalyticsExtra {
  cycle: SubscriptionCycles;
  cost: number;
  currency: string;
  payment: string;
  localCost: number;
  localCurrency: string;
  payout: TransactionPayoutTotalsNotification | null;
}

const getAnalyticsExtra = (
  data: (
    | SubscriptionUpdatedEvent
    | SubscriptionCanceledEvent
    | TransactionCompletedEvent
  )['data'],
): Partial<AnalyticsExtra> => {
  const cost = data.items?.[0]?.price?.unitPrice?.amount;
  const currency = data.items?.[0]?.price?.unitPrice?.currencyCode;
  const localCurrency = data.currencyCode;

  // payments are only available on transaction events
  if (!('payments' in data)) {
    return {
      cycle: extractSubscriptionCycle(data.items),
      cost: cost ? parseInt(cost) / 100 : undefined,
      currency,
      localCurrency,
    };
  }

  const transaction = data as TransactionCompletedEvent['data'];
  const localCost = transaction?.details?.totals?.total;
  const payout = transaction?.details?.payoutTotals;
  const payment = transaction.payments?.reduce((acc, item) => {
    if (item.status === 'captured') {
      acc = item?.methodDetails?.type || '';
    }
    return acc;
  }, '');

  return {
    cost: cost ? parseInt(cost) / 100 : undefined,
    currency,
    payment,
    localCost: localCost ? parseInt(localCost) / 100 : undefined,
    localCurrency,
    payout,
  };
};

const logPaddleAnalyticsEvent = async (
  event:
    | SubscriptionUpdatedEvent
    | SubscriptionCanceledEvent
    | TransactionCompletedEvent
    | undefined,
  eventName: AnalyticsEventName,
) => {
  if (!event) {
    return;
  }

  const { data, occurredAt, eventId } = event;
  const customData = data.customData as { user_id: string };
  const userId = await getUserId({
    userId: customData?.user_id,
    subscriptionId:
      ('subscriptionId' in data && data.subscriptionId) || data.id,
  });

  if (!userId) {
    return;
  }

  await sendAnalyticsEvent([
    {
      event_name: eventName,
      event_timestamp: new Date(occurredAt),
      event_id: eventId,
      app_platform: 'api',
      user_id: userId,
      extra: JSON.stringify(getAnalyticsExtra(data)),
      target_type: isCoreTransaction({ event })
        ? TargetType.Credits
        : TargetType.Plus,
    },
  ]);
};

const notifyNewPaddleTransaction = async ({
  event,
}: {
  event: TransactionCompletedEvent;
}) => {
  const { data } = event;
  const { customData, subscriptionId } = data ?? {};
  const { user_id, gifter_id } = (customData ?? {}) as PaddleCustomData;
  const purchasedById = gifter_id ?? user_id;
  const subscriptionForId = await getUserId({
    userId: user_id,
    subscriptionId,
  });
  const con = await createOrGetConnection();
  const flags = (
    await con.getRepository(User).findOne({
      select: ['subscriptionFlags'],
      where: { id: subscriptionForId },
    })
  )?.subscriptionFlags;

  if (gifter_id && !flags?.giftExpirationDate) {
    logger.error(
      { provider: SubscriptionProvider.Paddle, data: event },
      'Gifted subscription without expiration date',
    );
  }

  const origin = data?.origin;
  const productId = data?.items?.[0].price?.productId;

  const total = data?.items?.[0]?.price?.unitPrice?.amount || '0';
  const currencyCode =
    data?.items?.[0]?.price?.unitPrice?.currencyCode || 'USD';

  const localTotal = data?.details?.totals?.total || '0';
  const localCurrencyCode = data?.currencyCode || 'USD';

  if (origin === 'subscription_recurring') {
    return;
  }

  const headerText = (() => {
    if (gifter_id) {
      return 'Gift subscription :gift: :paddle:';
    }

    return 'New Plus subscriber :moneybag: :paddle:';
  })();

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Transaction ID:*',
            `<https://vendors.paddle.com/transactions-v2/${data.id}|${data.id}>`,
          ),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Customer ID:*',
            `<https://vendors.paddle.com/customers-v2/${data.customerId}|${data.customerId}>`,
          ),
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Type:*',
            `<https://vendors.paddle.com/products-v2/${productId}|${flags?.cycle}>`,
          ),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Purchased by:*',
            `<https://app.daily.dev/${purchasedById}|${purchasedById}>`,
          ),
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Cost:*',
            new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: currencyCode,
            }).format((parseFloat(total) || 0) / 100),
          ),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline('*Currency:*', currencyCode),
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Cost (local):*',
            new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: localCurrencyCode,
            }).format((parseFloat(localTotal) || 0) / 100),
          ),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline('*Currency (local):*', localCurrencyCode),
        },
      ],
    },
  ];

  if (gifter_id && flags?.giftExpirationDate) {
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Gifted to:*',
            `<https://app.daily.dev/${subscriptionForId}|${subscriptionForId}>`,
          ),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Gift expires:*',
            new Date(flags.giftExpirationDate).toLocaleDateString(),
          ),
        },
      ],
    });
  }

  await webhooks.transactions.send({ blocks });
};

const notifyNewPaddleCoresTransaction = async ({
  data,
  transaction,
  event,
}: {
  data: ReturnType<typeof getPaddleTransactionData>;
  transaction: UserTransaction;
  event: TransactionCompletedEvent;
}) => {
  const purchasedById = data.customData.user_id;

  const currencyCode =
    event?.data?.items?.[0]?.price?.unitPrice?.currencyCode || 'USD';

  const total = event?.data?.items?.[0]?.price?.unitPrice?.amount || '0';
  const localTotal = event?.data?.details?.totals?.total || '0';
  const localCurrencyCode = event?.data?.currencyCode || 'USD';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Cores purchased :cores:',
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Transaction ID:*',
            `<https://vendors.paddle.com/transactions-v2/${data.id}|${data.id}>`,
          ),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Customer ID:*',
            `<https://vendors.paddle.com/customers-v2/${event.data.customerId}|${event.data.customerId}>`,
          ),
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline('*Cores:*', transaction.value.toString()),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Purchased by:*',
            `<https://app.daily.dev/${purchasedById}|${purchasedById}>`,
          ),
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Cost:*',
            new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: currencyCode,
            }).format((parseFloat(total) || 0) / 100),
          ),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline('*Currency:*', currencyCode),
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: concatTextToNewline(
            '*Cost (local):*',
            new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: localCurrencyCode,
            }).format((parseFloat(localTotal) || 0) / 100),
          ),
        },
        {
          type: 'mrkdwn',
          text: concatTextToNewline('*Currency (local):*', localCurrencyCode),
        },
      ],
    },
  ];

  await webhooks.transactions.send({ blocks });
};

export const processGiftedPayment = async ({
  event,
}: {
  event: TransactionCompletedEvent;
}) => {
  const { data } = event;
  const con = await createOrGetConnection();
  const { gifter_id, user_id } = data.customData as PaddleCustomData;

  if (user_id === gifter_id) {
    logger.error(
      { provider: SubscriptionProvider.Paddle, data: event },
      'User and gifter are the same',
    );
    return;
  }

  const gifterUser = await con.getRepository(User).findOneBy({ id: gifter_id });

  if (!gifterUser) {
    logger.error(
      { provider: SubscriptionProvider.Paddle, data: event },
      'Gifter user not found',
    );
    return;
  }

  const targetUser = await con.getRepository(User).findOne({
    select: ['subscriptionFlags'],
    where: { id: user_id },
  });

  if (isPlusMember(targetUser?.subscriptionFlags?.cycle)) {
    logger.error(
      { provider: SubscriptionProvider.Paddle, data: event },
      'User is already a Plus member',
    );
    return;
  }

  await con.getRepository(User).update(
    { id: user_id },
    {
      subscriptionFlags: updateSubscriptionFlags({
        cycle: SubscriptionCycles.Yearly,
        createdAt: data?.createdAt,
        subscriptionId: data?.id,
        gifterId: gifter_id,
        giftExpirationDate: addMilliseconds(
          new Date(),
          plusGiftDuration,
        ).toISOString(),
        provider: SubscriptionProvider.Paddle,
      }),
      flags: updateFlagsStatement({ showPlusGift: true }),
    },
  );
};

const checkTransactionStatusValid = ({
  event,
  transaction,
  nextStatus,
  validStatus,
  data,
}: {
  event: EventEntity;
  transaction: UserTransaction;
  nextStatus: UserTransactionStatus;
  validStatus: UserTransactionStatus[];
  data: ReturnType<typeof getPaddleTransactionData>;
}): boolean => {
  if (!validStatus.includes(transaction.status)) {
    logger.warn(
      {
        eventType: event.eventType,
        provider: SubscriptionProvider.Paddle,
        currentStatus: transaction.status,
        nextStatus,
        data,
      },
      'Transaction with invalid status',
    );

    return false;
  }

  return true;
};

export const processTransactionCompleted = async ({
  event,
}: {
  event: TransactionCompletedEvent;
}) => {
  if (isCoreTransaction({ event })) {
    const transactionData = getPaddleTransactionData({ event });
    const con = await createOrGetConnection();

    let transaction = await getTransactionForProviderId({
      con,
      providerId: transactionData.id,
    });

    transaction = await con.transaction(async (entityManager) => {
      const userTransaction = await updateUserTransaction({
        con: entityManager,
        transaction,
        nextStatus: UserTransactionStatus.Success,
        data: transactionData,
        event,
      });

      const user: Pick<User, 'id' | 'coresRole'> = await entityManager
        .getRepository(User)
        .findOneOrFail({
          select: ['id', 'coresRole'],
          where: {
            id: transactionData.customData.user_id,
          },
        });

      if (
        checkUserCoresAccess({
          user,
          requiredRole: CoresRole.User,
        }) === false
      ) {
        throw new Error('User does not have access to cores purchase');
      }

      // skip njord if transaction has test discount
      const shouldSkipNjord =
        !!transactionData.discountId &&
        !!remoteConfig.vars.paddleTestDiscountIds?.includes(
          transactionData.discountId,
        );

      if (shouldSkipNjord) {
        await entityManager.getRepository(UserTransaction).update(
          {
            id: userTransaction.id,
          },
          {
            flags: updateFlagsStatement<UserTransaction>({
              note: 'NJORD_SKIPPED_FOR_TEST_DISCOUNT',
            }),
          },
        );
      }

      if (!shouldSkipNjord) {
        try {
          await purchaseCores({
            transaction: userTransaction,
          });
        } catch (error) {
          if (error instanceof TransferError) {
            const userTransactionError = new UserTransactionError({
              status: error.transfer.status,
              transaction: userTransaction,
            });

            // update transaction status to error
            await entityManager.getRepository(UserTransaction).update(
              {
                id: userTransaction.id,
              },
              {
                status: error.transfer.status as number,
                flags: updateFlagsStatement<UserTransaction>({
                  error: userTransactionError.message,
                }),
              },
            );

            return entityManager.getRepository(UserTransaction).create({
              ...userTransaction,
              status: error.transfer.status as number,
              flags: {
                ...userTransaction.flags,
                error: userTransactionError.message,
              },
            });
          }

          throw error;
        }
      }

      return userTransaction;
    });

    if (transaction.status === UserTransactionStatus.Success) {
      await notifyNewPaddleCoresTransaction({
        data: transactionData,
        transaction: transaction,
        event,
      });
    }

    return;
  }

  const { gifter_id } = (event?.data?.customData ?? {}) as PaddleCustomData;

  if (gifter_id) {
    await processGiftedPayment({ event });
  }

  await notifyNewPaddleTransaction({ event });
};

export const updateUserTransaction = async ({
  con,
  transaction,
  nextStatus,
  data,
}: {
  con: DataSource | EntityManager;
  transaction: UserTransaction | null;
  nextStatus?: UserTransactionStatus;
  data: ReturnType<typeof getPaddleTransactionData>;
  event: EventEntity;
}): Promise<UserTransaction> => {
  const providerTransactionId = data.id;

  const itemData = data.items[0];

  if (transaction) {
    if (transaction.receiverId !== data.customData.user_id) {
      throw new Error('Transaction receiver does not match user ID');
    }

    if (
      transaction.status === UserTransactionStatus.Success &&
      transaction.value !== itemData.price.customData.cores
    ) {
      throw new Error('Transaction value changed after success');
    }
  }

  const payload = con.getRepository(UserTransaction).create({
    processor: UserTransactionProcessor.Paddle,
    id: transaction?.id,
    receiverId: data.customData.user_id,
    status: nextStatus,
    productId: null, // no product user is buying cores directly
    senderId: null, // no sender, user is buying cores
    value: itemData.price.customData.cores,
    valueIncFees: itemData.price.customData.cores,
    fee: 0, // no fee when buying cores
    request: {},
    flags: {
      providerId: providerTransactionId,
    },
  });

  if (!transaction) {
    const insertResult = await con
      .getRepository(UserTransaction)
      .createQueryBuilder()
      .insert()
      .values(payload)
      .onConflict(
        `((flags->>'providerId')) DO UPDATE SET status = EXCLUDED.status,
            value = EXCLUDED.value,
            "valueIncFees" = EXCLUDED."valueIncFees",
            "updatedAt" = NOW()`,
      )
      .returning(['id'])
      .execute();

    payload.id = insertResult.raw[0].id;

    return payload;
  } else {
    await con.getRepository(UserTransaction).update(
      { id: transaction.id },
      {
        value: itemData.price.customData.cores,
        valueIncFees: itemData.price.customData.cores,
        status: nextStatus,
        flags: updateFlagsStatement<UserTransaction>({
          error: null,
        }),
      },
    );

    return con.getRepository(UserTransaction).create({
      ...transaction,
      value: itemData.price.customData.cores,
      valueIncFees: itemData.price.customData.cores,
      status: nextStatus ?? transaction.status,
      flags: {
        ...transaction.flags,
        error: null,
      },
    });
  }
};

export const processTransactionCreated = async ({
  event,
}: {
  event: TransactionCreatedEvent;
}) => {
  if (isCoreTransaction({ event })) {
    const transactionData = getPaddleTransactionData({ event });

    const con = await createOrGetConnection();

    const transaction = await getTransactionForProviderId({
      con,
      providerId: transactionData.id,
    });

    if (transaction) {
      logger.warn(
        {
          eventType: event.eventType,
          provider: SubscriptionProvider.Paddle,
          currentStatus: transaction.status,
          data: transactionData,
        },
        'Transaction already exists',
      );

      return;
    }

    await updateUserTransaction({
      con,
      transaction,
      nextStatus: UserTransactionStatus.Created,
      data: transactionData,
      event,
    });

    try {
      // update checkout url to point to cores since default is plus checkout
      await paddleInstance.transactions.update(transactionData.id, {
        checkout: {
          url: `${process.env.COMMENTS_PREFIX}/cores`,
        },
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          provider: SubscriptionProvider.Paddle,
          transactionId: transactionData.id,
        },
        'Failed to update checkout url',
      );
    }
  }
};

export const processTransactionPaid = async ({
  event,
}: {
  event: TransactionPaidEvent;
}) => {
  if (isCoreTransaction({ event })) {
    const transactionData = getPaddleTransactionData({ event });

    const con = await createOrGetConnection();

    const transaction = await getTransactionForProviderId({
      con,
      providerId: transactionData.id,
    });

    const nextStatus = UserTransactionStatus.Processing;

    if (
      transaction &&
      !checkTransactionStatusValid({
        event,
        transaction,
        nextStatus,
        validStatus: [
          UserTransactionStatus.Created,
          UserTransactionStatus.Processing,
          UserTransactionStatus.Error,
          UserTransactionStatus.ErrorRecoverable,
        ],
        data: transactionData,
      })
    ) {
      return;
    }

    await updateUserTransaction({
      con,
      transaction,
      nextStatus,
      data: transactionData,
      event,
    });
  }
};

export const processTransactionPaymentFailed = async ({
  event,
}: {
  event: TransactionPaymentFailedEvent;
}) => {
  if (isCoreTransaction({ event })) {
    const transactionData = getPaddleTransactionData({ event });

    const con = await createOrGetConnection();

    const transaction = await getTransactionForProviderId({
      con,
      providerId: transactionData.id,
    });

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    const paymentErrorCode = event.data.payments[0]?.errorCode;

    // for declined payments user can retry checkout
    const nextStatus = UserTransactionStatus.ErrorRecoverable;

    if (
      !checkTransactionStatusValid({
        event,
        transaction,
        nextStatus,
        validStatus: [
          UserTransactionStatus.Created,
          UserTransactionStatus.Processing,
          UserTransactionStatus.Error,
          UserTransactionStatus.ErrorRecoverable,
        ],
        data: transactionData,
      })
    ) {
      return;
    }

    await con.getRepository(UserTransaction).update(
      { id: transaction.id },
      {
        status: nextStatus,
        flags: updateFlagsStatement<UserTransaction>({
          error: `Payment failed: ${paymentErrorCode ?? 'unknown'}`,
        }),
      },
    );
  }
};

export const processTransactionUpdated = async ({
  event,
}: {
  event: TransactionUpdatedEvent;
}) => {
  if (isCoreTransaction({ event })) {
    const transactionData = getPaddleTransactionData({ event });

    const con = await createOrGetConnection();

    const transaction = await getTransactionForProviderId({
      con,
      providerId: transactionData.id,
    });

    if (transaction && transaction.updatedAt > transactionData.updatedAt) {
      logger.warn(
        {
          eventType: event.eventType,
          provider: SubscriptionProvider.Paddle,
          currentStatus: transaction.status,
          data: transactionData,
        },
        'Transaction already updated',
      );

      return;
    }

    // get status from update event, other events we don't handle as update
    // but wait for the dedicated eventType to process transaction
    const getUpdatedStatus = (): UserTransactionStatus | undefined => {
      if (transaction) {
        return transaction.status;
      }

      switch (event.data.status) {
        case 'draft':
        case 'ready':
          return UserTransactionStatus.Created;
        case 'billed':
          return UserTransactionStatus.Processing;
        default:
          return undefined;
      }
    };

    const nextStatus = getUpdatedStatus();

    if (typeof nextStatus === 'undefined') {
      logger.warn(
        {
          eventType: event.eventType,
          provider: SubscriptionProvider.Paddle,
          currentStatus: transaction?.status ?? 'unknown',
          data: transactionData,
        },
        'Transaction update skipped',
      );

      return;
    }

    await updateUserTransaction({
      con,
      transaction,
      data: transactionData,
      nextStatus: transaction ? undefined : nextStatus,
      event,
    });
  }
};

export const paddle = async (fastify: FastifyInstance): Promise<void> => {
  fastify.register(async (fastify: FastifyInstance): Promise<void> => {
    fastify.addHook('onRequest', async (request, res) => {
      if (
        isProd &&
        remoteConfig.vars.paddleIps &&
        !remoteConfig.vars.paddleIps.includes(request.ip)
      ) {
        return res.status(403).send({ error: 'Forbidden' });
      }
    });

    fastify.post('/', {
      config: {
        rawBody: true,
      },
      handler: async (req, res) => {
        const signature = (req.headers['paddle-signature'] as string) || '';
        const rawRequestBody = req.rawBody?.toString();
        const secretKey = process.env.PADDLE_WEBHOOK_SECRET || '';

        try {
          if (signature && rawRequestBody) {
            const eventData = await paddleInstance.webhooks.unmarshal(
              rawRequestBody,
              secretKey,
              signature,
            );

            switch (eventData?.eventType) {
              case EventName.TransactionCreated:
                await processTransactionCreated({
                  event: eventData,
                });

                break;
              case EventName.TransactionPaid:
                await processTransactionPaid({
                  event: eventData,
                });

                break;
              case EventName.SubscriptionCreated:
                await updateUserSubscription({
                  event: eventData,
                  state: true,
                });

                break;
              case EventName.TransactionPaymentFailed:
                await processTransactionPaymentFailed({
                  event: eventData,
                });

                break;
              case EventName.TransactionUpdated:
                await processTransactionUpdated({
                  event: eventData,
                });

                break;
              case EventName.SubscriptionCanceled:
                Promise.all([
                  updateUserSubscription({
                    event: eventData,
                    state: false,
                  }),
                  logPaddleAnalyticsEvent(
                    eventData,
                    AnalyticsEventName.CancelSubscription,
                  ),
                ]);
                break;
              case EventName.SubscriptionUpdated:
                const didPlanChange = await planChanged(eventData);
                if (didPlanChange) {
                  await updateUserSubscription({
                    event: eventData,
                    state: true,
                  });
                  await logPaddleAnalyticsEvent(
                    eventData,
                    AnalyticsEventName.ChangeBillingCycle,
                  );
                }
                break;
              case EventName.TransactionCompleted:
                await Promise.all([
                  logPaddleAnalyticsEvent(
                    eventData,
                    AnalyticsEventName.ReceivePayment,
                  ),
                  processTransactionCompleted({ event: eventData }),
                ]);
                break;
              default:
                logger.info(
                  { provider: SubscriptionProvider.Paddle },
                  eventData?.eventType,
                );
            }
          } else {
            logger.error(
              { provider: SubscriptionProvider.Paddle },
              'Signature missing in header',
            );
          }
        } catch (originalError) {
          const err = originalError as Error;

          logger.error(
            {
              err,
              provider: SubscriptionProvider.Paddle,
              payload: rawRequestBody,
            },
            'Paddle generic error',
          );
        }
        res.send('Processed webhook event');
      },
    });
  });
};
