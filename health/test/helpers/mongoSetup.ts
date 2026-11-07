import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup(project: TestProject) {
  const server = await MongoMemoryServer.create();
  project.provide('mongoUri', server.getUri());
  return () => server.stop();
}
