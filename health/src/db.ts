import { MongoClient } from 'mongodb';

/** Connect and return the app's database. */
export async function connectDb(uri: string, database: string) {
  // ignoreUndefined: optional fields left undefined are not stored as null.
  const client = new MongoClient(uri, { ignoreUndefined: true });
  await client.connect();
  return { client, db: client.db(database) };
}
