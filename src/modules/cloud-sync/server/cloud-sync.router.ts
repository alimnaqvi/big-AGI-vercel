import { z } from 'zod/v4';
import { createTRPCRouter, publicProcedure } from '~/server/trpc/trpc.server';
import { env } from '~/server/env.server';
import { prismaDb } from '~/server/prisma/prismaDb';

export const cloudSyncRouter = createTRPCRouter({

  isEnabled: publicProcedure
    .query(() => {
      return env.CLOUD_SYNC_ENABLED === 'true';
    }),

  listChats: publicProcedure
    .query(async () => {
      if (env.CLOUD_SYNC_ENABLED !== 'true' || !prismaDb) return [];
      return await prismaDb.cloudChat.findMany({
        select: {
          conversationId: true,
          chatUpdatedMs: true,
        },
      });
    }),

  getChats: publicProcedure
    .input(z.object({
      conversationIds: z.array(z.string()),
    }))
    .query(async ({ input }) => {
      if (env.CLOUD_SYNC_ENABLED !== 'true' || !prismaDb) return [];
      return await prismaDb.cloudChat.findMany({
        where: {
          conversationId: { in: input.conversationIds },
        },
        select: {
          conversationId: true,
          chatUpdatedMs: true,
          data: true,
        },
      });
    }),

  upsertChat: publicProcedure
    .input(z.object({
      conversationId: z.string(),
      data: z.any(),
      chatUpdatedMs: z.number(),
    }))
    .mutation(async ({ input }) => {
      if (env.CLOUD_SYNC_ENABLED !== 'true' || !prismaDb) return false;
      await prismaDb.cloudChat.upsert({
        where: { conversationId: input.conversationId },
        update: {
          data: input.data,
          chatUpdatedMs: input.chatUpdatedMs,
        },
        create: {
          conversationId: input.conversationId,
          data: input.data,
          chatUpdatedMs: input.chatUpdatedMs,
        },
      });
      return true;
    }),

  deleteChat: publicProcedure
    .input(z.object({
      conversationId: z.string(),
    }))
    .mutation(async ({ input }) => {
      if (env.CLOUD_SYNC_ENABLED !== 'true' || !prismaDb) return false;
      try {
        await prismaDb.cloudChat.delete({
          where: { conversationId: input.conversationId },
        });
        return true;
      } catch (e) {
        return false;
      }
    }),
});
