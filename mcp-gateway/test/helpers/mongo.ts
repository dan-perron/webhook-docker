import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, inject } from 'vitest';

/** A fresh database on the shared test mongod, dropped after the file. */
export async function testDb(): Promise<Db> {
  const client = new MongoClient(inject('mongoUri'));
  await client.connect();
  const db = client.db(`t_${randomUUID().slice(0, 8)}`);
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });
  return db;
}
