import { MongoClient, type Db } from 'mongodb';

export type { Db };

/** Connect and return the gateway's database (indexes are made by the store). */
export async function connectDb(uri: string, database: string) {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db(database) };
}
