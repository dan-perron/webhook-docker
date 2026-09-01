import { database } from '../connection.js';
import type {
  ExerciseBlock,
  ExercisePlan,
  ParsedPlan,
} from '../../../features/exercises/types.js';

const collection = database.collection<ExercisePlan>('exercisePlans');

export async function savePlan(
  userId: string,
  plan: ParsedPlan,
  rawMarkdown: string
): Promise<void> {
  await collection.updateMany(
    { userId, active: true },
    { $set: { active: false } }
  );
  await collection.insertOne({
    userId,
    createdAt: new Date(),
    active: true,
    blocks: plan.blocks,
    notes: plan.notes,
    slackNotes: plan.slackNotes,
    rawMarkdown,
  });
}

export async function getBlock(
  userId: string,
  hour: number
): Promise<ExerciseBlock | null> {
  const plan = await collection.findOne({ userId, active: true });
  if (!plan) return null;
  return plan.blocks.find((b) => b.hour === hour) ?? null;
}

export async function getActivePlan(
  userId: string
): Promise<ExercisePlan | null> {
  return collection.findOne({ userId, active: true });
}
