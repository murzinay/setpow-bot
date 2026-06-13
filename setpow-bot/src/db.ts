/**
 * Singleton PrismaClient. Импортируется отовсюду:  import { db } from './db'.
 */
import { PrismaClient } from '@prisma/client';

export const db = new PrismaClient({
  log: ['warn', 'error'],
});

export async function disconnectDb() {
  await db.$disconnect();
}
