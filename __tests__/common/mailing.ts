import nock from 'nock';
import { DataSource, In, Not } from 'typeorm';
import { saveFixtures } from '../helpers';
import createOrGetConnection from '../../src/db';
import {
  User,
  UserPersonalizedDigest,
  UserPersonalizedDigestType,
} from '../../src/entity';
import { usersFixture } from '../fixture/user';
import {
  CioUnsubscribeTopic,
  ghostUser,
  syncSubscription,
} from '../../src/common';

let con: DataSource;

beforeAll(async () => {
  con = await createOrGetConnection();
});

beforeEach(async () => {
  nock.cleanAll();
  process.env.CIO_APP_KEY = 'test';
  await saveFixtures(con, User, usersFixture);
});

describe('mailing', () => {
  describe('syncSubscription', () => {
    it('sync subscriptions for the given users', async () => {
      nock(`https://api.customer.io`)
        .post('/v1/customers/attributes', {
          ids: usersFixture.map((user) => user.id),
        })
        .reply(200, {
          customers: usersFixture.map((user) => ({
            id: user.id,
            attributes: {
              cio_subscription_preferences: JSON.stringify({
                topics: {
                  [`topic_${CioUnsubscribeTopic.Marketing}`]: false,
                  [`topic_${CioUnsubscribeTopic.Digest}`]: true,
                  [`topic_${CioUnsubscribeTopic.Notifications}`]: true,
                  [`topic_${CioUnsubscribeTopic.Follow}`]: false,
                  [`topic_${CioUnsubscribeTopic.Award}`]: false,
                },
              }),
            },
            unsubscribed: false,
          })),
        });

      await syncSubscription(
        usersFixture.map((user) => user.id as string),
        con,
      );

      const users = await con.getRepository(User).find({
        where: {
          id: Not(ghostUser.id),
        },
      });

      const digests = await con.getRepository(UserPersonalizedDigest).findBy({
        userId: In(users.map((user) => user.id)),
        type: UserPersonalizedDigestType.Digest,
      });

      expect(digests).toHaveLength(4);

      users.forEach((user, index) => {
        expect(user.acceptedMarketing).toBe(false);
        expect(user.notificationEmail).toBe(true);
        expect(digests[index]).toMatchObject({
          userId: user.id,
          type: UserPersonalizedDigestType.Digest,
        });
        expect(user.followingEmail).toBe(false);
        expect(user.awardEmail).toBe(false);
      });
    });
  });
});
