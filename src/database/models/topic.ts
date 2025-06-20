import { count, sql } from 'drizzle-orm';
import { and, desc, eq, gt, ilike, inArray, isNull } from 'drizzle-orm/expressions';

import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { LobeChatDatabase } from '@/database/type';
import {
  genEndDateWhere,
  genRangeWhere,
  genStartDateWhere,
  genWhere,
} from '@/database/utils/genWhere';
import { idGenerator } from '@/database/utils/idGenerator';
import { MessageItem } from '@/types/message';
import { TopicRankItem } from '@/types/topic';

import { TopicItem, messages, topics } from '../schemas'; // Assuming threads schema is not directly managed by TopicModel for CRUD of its title

export interface CreateTopicParams {
  favorite?: boolean;
  messages?: string[]; // Assuming these are message IDs, not content
  sessionId?: string | null;
  title: string; // Will be encrypted
  historySummary?: string | null; // Will be encrypted
}

interface QueryTopicParams {
  current?: number;
  pageSize?: number;
  sessionId?: string | null;
}

export class TopicModel {
  private userId: string;
  private db: LobeChatDatabase;
  private gatekeeper: Promise<KeyVaultsGateKeeper>;

  constructor(db: LobeChatDatabase, userId: string) {
    this.userId = userId;
    this.db = db;
    this.gatekeeper = KeyVaultsGateKeeper.initWithEnvKey();
  }

  private async decryptField(encryptedText: string | null | undefined): Promise<string | null | undefined> {
    if (typeof encryptedText !== 'string' || encryptedText.length === 0) {
      return encryptedText;
    }
    if (encryptedText.startsWith("[Decryption Error:")) {
      return encryptedText;
    }
    if (!encryptedText.includes(':') || encryptedText.split(':').length !== 3) {
      // console.warn(`[TopicModel] Field for user ${this.userId} does not appear to be encrypted, returning as is: ${encryptedText.substring(0, 50)}...`);
      return encryptedText;
    }
    try {
      const keeper = await this.gatekeeper;
      const { plaintext, wasAuthentic } = await keeper.decrypt(encryptedText);
      if (wasAuthentic) {
        return plaintext;
      }
      console.error(`[TopicModel] Failed to authenticate decrypted field for user ${this.userId}. Encrypted: ${encryptedText.substring(0,50)}...`);
      return "[Decryption Error: Data integrity check failed]";
    } catch (error) {
      console.error(`[TopicModel] Error decrypting field for user ${this.userId}:`, error, `Encrypted: ${encryptedText.substring(0,50)}...`);
      return "[Decryption Error: Invalid format or key]";
    }
  }

  // **************** Query *************** //

  query = async ({ current = 0, pageSize = 9999, sessionId }: QueryTopicParams = {}): Promise<TopicItem[]> => {
    const offset = current * pageSize;
    const result = await this.db
      .select({
        createdAt: topics.createdAt,
        favorite: topics.favorite,
        historySummary: topics.historySummary, // Will be decrypted
        id: topics.id,
        metadata: topics.metadata,
        title: topics.title, // Will be decrypted
        updatedAt: topics.updatedAt,
        sessionId: topics.sessionId, // Added for complete TopicItem
        clientId: topics.clientId, // Added for complete TopicItem
        userId: topics.userId, // Added for complete TopicItem
      })
      .from(topics)
      .where(and(eq(topics.userId, this.userId), this.matchSession(sessionId)))
      .orderBy(desc(topics.favorite), desc(topics.updatedAt))
      .limit(pageSize)
      .offset(offset);

    return Promise.all(
      result.map(async (item) => ({
        ...item,
        title: await this.decryptField(item.title),
        historySummary: await this.decryptField(item.historySummary),
      }))
    ) as Promise<TopicItem[]>;
  };

  findById = async (id: string): Promise<TopicItem | undefined> => {
    const topic = await this.db.query.topics.findFirst({
      where: and(eq(topics.id, id), eq(topics.userId, this.userId)),
    });
    if (topic) {
      topic.title = await this.decryptField(topic.title);
      topic.historySummary = await this.decryptField(topic.historySummary);
    }
    return topic as TopicItem | undefined;
  };

  queryAll = async (): Promise<TopicItem[]> => {
    const result = await this.db
      .select()
      .from(topics)
      .orderBy(topics.updatedAt)
      .where(eq(topics.userId, this.userId));
    return Promise.all(
      result.map(async (item) => ({
        ...item,
        title: await this.decryptField(item.title),
        historySummary: await this.decryptField(item.historySummary),
      }))
    ) as Promise<TopicItem[]>;
  };

  queryByKeyword = async (keyword: string, sessionId?: string | null): Promise<TopicItem[]> => {
    if (!keyword) return [];
    const keywordLowerCase = keyword.toLowerCase();

    // Fetch all topics for the user/session, then decrypt and filter.
    // Direct SQL LIKE on encrypted titles or message content is not feasible.
    const allUserTopics = await this.db.query.topics.findMany({
        orderBy: [desc(topics.updatedAt)],
        where: and(
          eq(topics.userId, this.userId),
          this.matchSession(sessionId)
        ),
    });

    const decryptedTopics = await Promise.all(
        allUserTopics.map(async (topic) => ({
            ...topic,
            title: await this.decryptField(topic.title),
            // historySummary also could be searched, but not implemented here for brevity
        }))
    );

    const topicsByTitle = decryptedTopics.filter(topic =>
        topic.title?.toLowerCase().includes(keywordLowerCase)
    );

    // Message content search (remains complex with encryption)
    // The original logic searched messages.content directly.
    // With encrypted messages.content, this requires fetching messages, decrypting, then checking.
    // This is very inefficient if done per topic.
    // A simpler approach for now: filter by title only, or accept that message content search is limited.
    // For this iteration, we'll primarily rely on title search after decryption.
    // A more advanced search would require different indexing or fetching all messages for matched topics.
    // console.warn("[TopicModel.queryByKeyword] Searching message content is limited due to encryption.");

    // To keep some message-based search (though inefficient):
    // 1. Get topics matching by title (done above).
    // 2. Separately, get all messages for the user/session, decrypt them, then find which topics they belong to if they match keyword.
    // This is still complex. For now, let's simplify and mainly focus on title search.

    // Placeholder for message content search - this part needs MessageModel interaction and is complex
    const messageModel = new (await import('@/database/models/message')).MessageModel(this.db, this.userId);
    const allMessages = await messageModel.queryAll(); // This will decrypt messages
    const topicIdsFromMessages = new Set<string>();
    for (const message of allMessages) {
        if (message.content?.toLowerCase().includes(keywordLowerCase) && message.topicId) {
            topicIdsFromMessages.add(message.topicId);
        }
    }

    const topicsFoundByMessageContent = decryptedTopics.filter(topic => topicIdsFromMessages.has(topic.id));

    const combinedResults = [...topicsByTitle];
    const existingIds = new Set(topicsByTitle.map(t => t.id));

    for (const topic of topicsFoundByMessageContent) {
        if (!existingIds.has(topic.id)) {
            combinedResults.push(topic);
            existingIds.add(topic.id);
        }
    }

    return combinedResults.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()) as TopicItem[];
  };

  count = async (params?: { endDate?: string; range?: [string, string]; startDate?: string; }): Promise<number> => {
    const result = await this.db
      .select({ count: count(topics.id) })
      .from(topics)
      .where(
        genWhere([
          eq(topics.userId, this.userId),
          params?.range ? genRangeWhere(params.range, topics.createdAt, (date) => date.toDate()) : undefined,
          params?.endDate ? genEndDateWhere(params.endDate, topics.createdAt, (date) => date.toDate()) : undefined,
          params?.startDate ? genStartDateWhere(params.startDate, topics.createdAt, (date) => date.toDate()) : undefined,
        ]),
      );
    return result[0].count;
  };

  rank = async (limit: number = 10): Promise<TopicRankItem[]> => {
    // This rank is based on message count, title decryption isn't strictly needed for the ranking logic itself
    // but if displayed, the title should be decrypted.
    const rankedTopics = await this.db
      .select({
        count: count(messages.id).as('count'),
        id: topics.id,
        sessionId: topics.sessionId,
        title: topics.title, // Will be decrypted
      })
      .from(topics)
      .where(and(eq(topics.userId, this.userId)))
      .leftJoin(messages, eq(topics.id, messages.topicId))
      .groupBy(topics.id)
      .orderBy(desc(sql`count`))
      .having(({ count }) => gt(count, 0))
      .limit(limit);

    return Promise.all(rankedTopics.map(async topic => ({
        ...topic,
        title: await this.decryptField(topic.title)
    })));
  };

  // **************** Create *************** //
  create = async (
    { messages: messageIds, title, historySummary, ...params }: CreateTopicParams,
    id: string = this.genId(),
  ): Promise<TopicItem> => {
    const keeper = await this.gatekeeper;
    const encryptedTitle = typeof title === 'string' && title.length > 0 ? await keeper.encrypt(title) : title;
    const encryptedHistorySummary = typeof historySummary === 'string' && historySummary.length > 0 ? await keeper.encrypt(historySummary) : historySummary;

    return this.db.transaction(async (tx) => {
      const [topicData] = await tx
        .insert(topics)
        .values({
          ...params,
          title: encryptedTitle,
          historySummary: encryptedHistorySummary,
          id: id,
          userId: this.userId,
        })
        .returning();

      if (messageIds && messageIds.length > 0) {
        await tx.update(messages).set({ topicId: topicData.id }).where(and(eq(messages.userId, this.userId), inArray(messages.id, messageIds)));
      }
      // Return with decrypted fields for immediate use
      return { ...topicData, title: title, historySummary: historySummary } as TopicItem;
    });
  };

  batchCreate = async (topicParams: (CreateTopicParams & { id?: string })[]) => {
    const keeper = await this.gatekeeper;
    return this.db.transaction(async (tx) => {
      const topicsToInsert = await Promise.all(topicParams.map(async (params) => {
        const encryptedTitle = typeof params.title === 'string' && params.title.length > 0 ? await keeper.encrypt(params.title) : params.title;
        const encryptedHistorySummary = typeof params.historySummary === 'string' && params.historySummary.length > 0 ? await keeper.encrypt(params.historySummary) : params.historySummary;
        return {
          favorite: params.favorite,
          id: params.id || this.genId(),
          sessionId: params.sessionId,
          title: encryptedTitle,
          historySummary: encryptedHistorySummary,
          userId: this.userId,
        };
      }));

      const createdTopics = await tx.insert(topics).values(topicsToInsert).returning();

      await Promise.all(
        createdTopics.map(async (topic, index) => {
          const messageIds = topicParams[index].messages;
          if (messageIds && messageIds.length > 0) {
            await tx.update(messages).set({ topicId: topic.id }).where(and(eq(messages.userId, this.userId), inArray(messages.id, messageIds)));
          }
        }),
      );
      // Return with decrypted fields
      return Promise.all(createdTopics.map(async (topic, index) => ({
          ...topic,
          title: topicParams[index].title, // original plaintext
          historySummary: topicParams[index].historySummary, // original plaintext
      }))) as Promise<TopicItem[]>;
    });
  };

  duplicate = async (topicId: string, newTitle?: string) => {
    const keeper = await this.gatekeeper;
    return this.db.transaction(async (tx) => {
      const originalTopic = await tx.query.topics.findFirst({
        where: and(eq(topics.id, topicId), eq(topics.userId, this.userId)),
      });
      if (!originalTopic) throw new Error(`Topic with id ${topicId} not found`);

      const decryptedOriginalTitle = await this.decryptField(originalTopic.title);
      const decryptedOriginalHistorySummary = await this.decryptField(originalTopic.historySummary);

      const titleToUse = newTitle || decryptedOriginalTitle;
      const encryptedNewTitle = typeof titleToUse === 'string' && titleToUse.length > 0 ? await keeper.encrypt(titleToUse) : titleToUse;
      // For duplication, historySummary is usually re-generated or copied. If copied, it should be re-encrypted.
      // Assuming we copy the decrypted original for re-encryption:
      const encryptedNewHistorySummary = typeof decryptedOriginalHistorySummary === 'string' && decryptedOriginalHistorySummary.length > 0 ? await keeper.encrypt(decryptedOriginalHistorySummary) : decryptedOriginalHistorySummary;


      const [duplicatedTopicData] = await tx
        .insert(topics)
        .values({
          ...originalTopic,
          title: encryptedNewTitle,
          historySummary: encryptedNewHistorySummary,
          clientId: null, // Clear client-specific ID
          id: this.genId(),
          createdAt: new Date(), // Reset dates
          updatedAt: new Date(),
        })
        .returning();

      const originalMessages = await tx.select().from(messages).where(and(eq(messages.topicId, topicId), eq(messages.userId, this.userId)));

      // Duplicating messages would require re-encrypting their content as well.
      // This part needs MessageModel interaction or direct encryption here.
      // For simplicity, this example might not fully re-encrypt message content during duplication if it's complex.
      // Assuming MessageModel handles its own encryption on create:
      const messageModel = new (await import('@/database/models/message')).MessageModel(tx, this.userId);
      const duplicatedMessagesPromises = originalMessages.map(async (message) => {
          const decryptedContent = await messageModel['decryptContent'](message.content); // Access private method for this specific case or expose helper
          // Create new message (this will re-encrypt)
          // This is a simplified representation; CreateMessageParams structure is needed.
          const newMessageParams: CreateMessageParams = {
              ...message, // Spread original message data
              content: decryptedContent || '', // Use decrypted content
              topicId: duplicatedTopicData.id,
              sessionId: duplicatedTopicData.sessionId, // Ensure session ID is correct
              id: undefined, // Let create generate new ID
              clientId: null, // Clear client-specific ID for message
              // Map other fields as needed for CreateMessageParams
              fromModel: message.model,
              fromProvider: message.provider,
              // plugin data would also need careful handling (decryption and re-encryption of arguments)
          };
          return messageModel.create(newMessageParams);
      });
      const duplicatedMessages = await Promise.all(duplicatedMessagesPromises);


      return {
        messages: duplicatedMessages, // These would be MessageItem from create, ideally with plaintext
        topic: { ...duplicatedTopicData, title: titleToUse, historySummary: decryptedOriginalHistorySummary } as TopicItem, // Return with decrypted fields
      };
    });
  };

  // **************** Delete *************** //
  delete = async (id: string) => this.db.delete(topics).where(and(eq(topics.id, id), eq(topics.userId, this.userId)));
  batchDeleteBySessionId = async (sessionId?: string | null) => this.db.delete(topics).where(and(this.matchSession(sessionId), eq(topics.userId, this.userId)));
  batchDelete = async (ids: string[]) => this.db.delete(topics).where(and(inArray(topics.id, ids), eq(topics.userId, this.userId)));
  deleteAll = async () => this.db.delete(topics).where(eq(topics.userId, this.userId));

  // **************** Update *************** //
  update = async (id: string, data: Partial<TopicItem>) => {
    const keeper = await this.gatekeeper;
    const dataToUpdate = { ...data, updatedAt: new Date() };

    if (typeof data.title === 'string') {
      dataToUpdate.title = data.title.length > 0 ? await keeper.encrypt(data.title) : data.title;
    } else if (data.title === null) {
      dataToUpdate.title = null;
    }

    if (typeof data.historySummary === 'string') {
      dataToUpdate.historySummary = data.historySummary.length > 0 ? await keeper.encrypt(data.historySummary) : data.historySummary;
    } else if (data.historySummary === null) {
        dataToUpdate.historySummary = null;
    }


    const [updatedTopic] = await this.db
      .update(topics)
      .set(dataToUpdate)
      .where(and(eq(topics.id, id), eq(topics.userId, this.userId)))
      .returning();

    if (updatedTopic) {
        return { ...updatedTopic, title: data.title ?? updatedTopic.title, historySummary: data.historySummary ?? updatedTopic.historySummary } as TopicItem;
    }
    return undefined; // Or throw error
  };

  // **************** Helper *************** //
  private genId = () => idGenerator('topics');
  private matchSession = (sessionId?: string | null) => sessionId ? eq(topics.sessionId, sessionId) : isNull(topics.sessionId);
}
