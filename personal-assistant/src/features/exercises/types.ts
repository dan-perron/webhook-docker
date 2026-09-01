import type { ObjectId } from 'mongodb';

export interface ExerciseBlock {
  hour: number; // 0–23 (24h format)
  title: string;
  markdownBody: string;
  slackBody: string; // pre-converted Slack mrkdwn
}

export interface ParsedPlan {
  blocks: ExerciseBlock[];
  notes?: string; // "Current Active Modifications" section, markdown
  slackNotes?: string; // pre-converted Slack mrkdwn
}

export interface ExercisePlan {
  _id?: ObjectId;
  userId: string;
  createdAt: Date;
  active: boolean;
  blocks: ExerciseBlock[];
  notes?: string;
  slackNotes?: string;
  rawMarkdown?: string;
}

export interface DailyMessage {
  _id?: ObjectId;
  userId: string;
  date: string; // ISO date "YYYY-MM-DD"
  channelId: string;
  messageTs: string;
}
