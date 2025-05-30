import { Column, Entity, Index, ManyToOne, PrimaryColumn } from 'typeorm';
import type { User } from './user';
import { ReportReason } from './common';

@Entity()
export class PostReport {
  @PrimaryColumn({ type: 'text' })
  @Index('IDX_post_report_post_id')
  postId: string;

  @PrimaryColumn({ length: 36 })
  @Index('IDX_post_report_user_id')
  userId: string;

  @Column({ default: () => 'now()' })
  createdAt: Date;

  @Column({ length: 30, type: 'varchar' })
  reason: ReportReason;

  @Column({ type: 'text', array: true, default: null })
  tags?: string[];

  @Column({ type: 'text', nullable: true })
  comment: string;

  @ManyToOne('User', {
    lazy: true,
    onDelete: 'CASCADE',
  })
  user: Promise<User>;
}
