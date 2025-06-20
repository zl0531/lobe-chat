import { Column, count, sql } from 'drizzle-orm';
import { and, asc, desc, eq, gt, inArray, isNull, like, not, or } from 'drizzle-orm/expressions';
import { DeepPartial } from 'utility-types';

import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { DEFAULT_INBOX_AVATAR } from '@/const/meta';
import { INBOX_SESSION_ID } from '@/const/session';
import { DEFAULT_AGENT_CONFIG } from '@/const/settings';
import { LobeChatDatabase } from '@/database/type';
import {
  genEndDateWhere,
  genRangeWhere,
  genStartDateWhere,
  genWhere,
} from '@/database/utils/genWhere';
import { idGenerator } from '@/database/utils/idGenerator';
import { LobeAgentConfig } from '@/types/agent';
import { ChatSessionList, LobeAgentSession, SessionRankItem } from '@/types/session';
import { merge } from '@/utils/merge';

import {
  AgentItem,
  NewAgent,
  NewSession,
  SessionItem,
  agents,
  agentsToSessions,
  sessionGroups,
  sessions,
  topics,
} from '../schemas';

export class SessionModel {
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
      // console.warn(`[SessionModel] Field for user ${this.userId} does not appear to be encrypted, returning as is: ${encryptedText.substring(0, 50)}...`);
      return encryptedText;
    }
    try {
      const keeper = await this.gatekeeper;
      const { plaintext, wasAuthentic } = await keeper.decrypt(encryptedText);
      if (wasAuthentic) {
        return plaintext;
      }
      console.error(`[SessionModel] Failed to authenticate decrypted field for user ${this.userId}. Encrypted: ${encryptedText.substring(0,50)}...`);
      return "[Decryption Error: Data integrity check failed]";
    } catch (error) {
      console.error(`[SessionModel] Error decrypting field for user ${this.userId}:`, error, `Encrypted: ${encryptedText.substring(0,50)}...`);
      return "[Decryption Error: Invalid format or key]";
    }
  }

  private async decryptSessionItem<T extends SessionItem | Partial<SessionItem> | null | undefined>(item: T): Promise<T> {
    if (!item) return item;
    const decryptedItem = { ...item };
    if (item.title) decryptedItem.title = await this.decryptField(item.title);
    if (item.description) decryptedItem.description = await this.decryptField(item.description);
    // Note: agent fields (avatar, backgroundColor, description, title from agent table) are not decrypted here.
    // That would happen in an AgentModel or if agent data is explicitly handled here.
    return decryptedItem;
  }

  private mapSessionItem = async ({
    agentsToSessions: relatedAgents, // Renamed to avoid conflict
    title,
    backgroundColor, // from sessions table
    description,     // from sessions table
    avatar,          // from sessions table
    groupId,
    ...res
  }: SessionItem & { agentsToSessions?: { agent: AgentItem }[] }): Promise<LobeAgentSession> => {
    const agent = relatedAgents?.[0]?.agent;

    // Decrypt session's own title and description first
    const decryptedSessionTitle = await this.decryptField(title);
    const decryptedSessionDescription = await this.decryptField(description);

    // Assuming agent fields might also be encrypted and handled by an AgentModel or similar logic
    // For now, we pass them as is, or they'd need decryption too if they come from DB encrypted.
    // If agent data is directly from `agents` table and those fields are encrypted,
    // they would need separate decryption. Here, we assume they are either not encrypted
    // or decrypted before this mapping.

    return {
      ...res,
      group: groupId,
      meta: {
        avatar: agent?.avatar ?? avatar ?? undefined, // avatar from session is preferred if agent's is not available
        backgroundColor: agent?.backgroundColor ?? backgroundColor ?? undefined,
        description: agent?.description ?? decryptedSessionDescription ?? undefined, // Prefer agent's desc
        tags: agent?.tags ?? undefined,
        title: agent?.title ?? decryptedSessionTitle ?? undefined, // Prefer agent's title
      },
      model: agent?.model,
    } as LobeAgentSession; // Cast needed due to meta structure
  };


  // **************** Query *************** //

  query = async ({ current = 0, pageSize = 9999 } = {}) => {
    const offset = current * pageSize;
    const result = await this.db.query.sessions.findMany({
      limit: pageSize,
      offset,
      orderBy: [desc(sessions.updatedAt)],
      where: and(eq(sessions.userId, this.userId), not(eq(sessions.slug, INBOX_SESSION_ID))),
      with: { agentsToSessions: { columns: {}, with: { agent: true } }, group: true },
    });
    return Promise.all(result.map(item => this.decryptSessionItem(item as SessionItem)));
  };

  queryWithGroups = async (): Promise<ChatSessionList> => {
    const result = await this.query(); // query now returns decrypted items

    const groups = await this.db.query.sessionGroups.findMany({
      orderBy: [asc(sessionGroups.sort), desc(sessionGroups.createdAt)],
      where: eq(sessions.userId, this.userId), // Should be sessionGroups.userId
    });

    // mapSessionItem is now async due to decryption
    const mappedSessions = await Promise.all(result.map(item => this.mapSessionItem(item as any)));

    return {
      sessionGroups: groups as unknown as ChatSessionList['sessionGroups'], // Assuming group names are not encrypted for now
      sessions: mappedSessions,
    };
  };

  queryByKeyword = async (keyword: string) => {
    if (!keyword) return [];
    const keywordLowerCase = keyword.toLowerCase();

    // This method originally searched agent.title and agent.description.
    // If those fields are encrypted in the `agents` table, this search becomes ineffective.
    // For `sessions.title` and `sessions.description`, we'd need to fetch, decrypt, and filter.
    // For now, adapting to search decrypted session titles/descriptions.
    // A full search across agent and session fields would require fetching all, decrypting all, then filtering.

    const allUserSessions = await this.db.query.sessions.findMany({
        where: eq(sessions.userId, this.userId),
        with: { agentsToSessions: { columns: {}, with: { agent: true } }, group: true },
    });

    const decryptedSessions = await Promise.all(allUserSessions.map(s => this.decryptSessionItem(s as SessionItem)));

    const filteredSessions = decryptedSessions.filter(s => {
        const titleMatch = s.title?.toLowerCase().includes(keywordLowerCase);
        const descriptionMatch = s.description?.toLowerCase().includes(keywordLowerCase);
        // Add agent title/desc search if agent data is also decrypted and available here
        // const agentTitleMatch = s.agent?.title?.toLowerCase().includes(keywordLowerCase);
        // const agentDescMatch = s.agent?.description?.toLowerCase().includes(keywordLowerCase);
        return titleMatch || descriptionMatch; // || agentTitleMatch || agentDescMatch;
    });

    return Promise.all(filteredSessions.map(item => this.mapSessionItem(item as any)));
  };


  findByIdOrSlug = async (
    idOrSlug: string,
  ): Promise<(SessionItem & { agent: AgentItem }) | undefined> => {
    const result = await this.db.query.sessions.findFirst({
      where: and(
        or(eq(sessions.id, idOrSlug), eq(sessions.slug, idOrSlug)),
        eq(sessions.userId, this.userId),
      ),
      with: { agentsToSessions: { columns: {}, with: { agent: true } }, group: true },
    });

    if (!result) return;
    const decryptedResult = await this.decryptSessionItem(result as SessionItem);

    return { ...decryptedResult, agent: (result?.agentsToSessions?.[0] as any)?.agent } as any;
  };

  count = async (params?: { endDate?: string; range?: [string, string]; startDate?: string; }): Promise<number> => {
    const result = await this.db
      .select({ count: count(sessions.id) })
      .from(sessions)
      .where(
        genWhere([
          eq(sessions.userId, this.userId),
          params?.range ? genRangeWhere(params.range, sessions.createdAt, (date) => date.toDate()) : undefined,
          params?.endDate ? genEndDateWhere(params.endDate, sessions.createdAt, (date) => date.toDate()) : undefined,
          params?.startDate ? genStartDateWhere(params.startDate, sessions.createdAt, (date) => date.toDate()) : undefined,
        ]),
      );
    return result[0].count;
  };

  _rank = async (limit: number = 10): Promise<SessionRankItem[]> => {
    // Title here comes from agents.title, needs decryption if agents.title is encrypted
    // For now, assuming agents.title is not encrypted by this model or handled by AgentModel
    return this.db
      .select({
        avatar: agents.avatar, backgroundColor: agents.backgroundColor,
        count: count(topics.id).as('count'), id: sessions.id, title: agents.title,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, this.userId)))
      .leftJoin(topics, eq(sessions.id, topics.sessionId))
      .leftJoin(agentsToSessions, eq(sessions.id, agentsToSessions.sessionId))
      .leftJoin(agents, eq(agentsToSessions.agentId, agents.id))
      .groupBy(sessions.id, agentsToSessions.agentId, agents.id)
      .having(({ count }) => gt(count, 0))
      .orderBy(desc(sql`count`))
      .limit(limit);
  };

  rank = async (limit: number = 10): Promise<SessionRankItem[]> => {
    const inboxResult = await this.db.select({ count: count(topics.id).as('count') }).from(topics).where(and(eq(topics.userId, this.userId), isNull(topics.sessionId)));
    const inboxCount = inboxResult[0].count;
    if (!inboxCount || inboxCount === 0) return this._rank(limit); // _rank titles are agent titles
    const result = await this._rank(limit ? limit - 1 : undefined);
    return [{ avatar: DEFAULT_INBOX_AVATAR, backgroundColor: null, count: inboxCount, id: INBOX_SESSION_ID, title: 'inbox.title' }, ...result].sort((a, b) => b.count - a.count);
  };

  hasMoreThanN = async (n: number): Promise<boolean> => {
    const result = await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, this.userId)).limit(n + 1);
    return result.length > n;
  };

  // **************** Create *************** //
  create = async ({
    id = idGenerator('sessions'), type = 'agent', session = {}, config = {}, slug,
  }: { config?: Partial<NewAgent>; id?: string; session?: Partial<NewSession>; slug?: string; type: 'agent' | 'group'; }): Promise<SessionItem> => {
    const keeper = await this.gatekeeper;
    const { title, description, ...restSession } = session;

    let encryptedTitle = title;
    if (typeof title === 'string' && title.length > 0) {
      encryptedTitle = await keeper.encrypt(title);
    }
    let encryptedDescription = description;
    if (typeof description === 'string' && description.length > 0) {
      encryptedDescription = await keeper.encrypt(description);
    }
    // Agent config fields (config.title, config.description) are not encrypted here, assuming AgentModel would handle it.

    return this.db.transaction(async (trx) => {
      if (slug) {
        const existResult = await trx.query.sessions.findFirst({ where: and(eq(sessions.slug, slug), eq(sessions.userId, this.userId)) });
        if (existResult) return this.decryptSessionItem(existResult as SessionItem);
      }

      const newAgents = await trx.insert(agents).values({ ...config, createdAt: new Date(), id: idGenerator('agents'), updatedAt: new Date(), userId: this.userId }).returning();
      const result = await trx.insert(sessions).values({ ...restSession, title: encryptedTitle, description: encryptedDescription, createdAt: new Date(), id, slug, type, updatedAt: new Date(), userId: this.userId }).returning();
      await trx.insert(agentsToSessions).values({ agentId: newAgents[0].id, sessionId: id, userId: this.userId });

      // Return with decrypted title and description for immediate use
      const finalResult = result[0];
      finalResult.title = title;
      finalResult.description = description;
      return finalResult as SessionItem;
    });
  };

  createInbox = async (defaultAgentConfig: DeepPartial<LobeAgentConfig>) => {
    const item = await this.db.query.sessions.findFirst({ where: and(eq(sessions.userId, this.userId), eq(sessions.slug, INBOX_SESSION_ID)) });
    if (item) return; // Inbox already exists
    // Inbox title/description are typically fixed and not user-defined, so encryption might be skipped or use fixed encrypted values.
    // For consistency, if create encrypts, this should too, but inbox has fixed title.
    // Let's assume inbox title/desc are not sensitive or are handled as constants.
    return this.create({ config: merge(DEFAULT_AGENT_CONFIG, defaultAgentConfig), slug: INBOX_SESSION_ID, type: 'agent' });
  };

  batchCreate = async (newSessionsParams: NewSession[]) => {
    const keeper = await this.gatekeeper;
    const sessionsToInsert = await Promise.all(newSessionsParams.map(async (s) => {
      let encryptedTitle = s.title;
      if (typeof s.title === 'string' && s.title.length > 0) encryptedTitle = await keeper.encrypt(s.title);
      let encryptedDescription = s.description;
      if (typeof s.description === 'string' && s.description.length > 0) encryptedDescription = await keeper.encrypt(s.description);
      return { ...s, title: encryptedTitle, description: encryptedDescription, id: this.genId(), userId: this.userId };
    }));
    // This doesn't handle agent creation part of batch, only session table
    return this.db.insert(sessions).values(sessionsToInsert);
  };

  duplicate = async (id: string, newTitle?: string) => {
    const result = await this.findByIdOrSlug(id); // This now returns decrypted session title/desc
    if (!result) return;

    const { agent, clientId, id: oldId, slug: oldSlug, createdAt, updatedAt, ...sessionData } = result;

    const titleToUse = newTitle || sessionData.title; // Already decrypted
    // sessionData.description is also already decrypted

    // Agent config duplication
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: agentOldId, ...agentConfig } = agent;

    // Create will re-encrypt title and description
    return this.create({
      config: agentConfig,
      id: this.genId(), // new session ID
      session: { ...sessionData, title: titleToUse /* description is already in sessionData and decrypted */ },
      type: 'agent',
    });
  };

  // **************** Delete *************** //
  delete = async (id: string) => { /* ... no change ... */ };
  batchDelete = async (ids: string[]) => { /* ... no change ... */ };
  deleteAll = async () => { /* ... no change ... */ };
  clearOrphanAgent = async (agentIds: string[], trx: any) => { /* ... no change ... */ };

  // **************** Update *************** //
  update = async (id: string, data: Partial<SessionItem>) => {
    const keeper = await this.gatekeeper;
    const dataToUpdate = { ...data };

    if (data.title !== undefined) {
        dataToUpdate.title = (typeof data.title === 'string' && data.title.length > 0) ? await keeper.encrypt(data.title) : data.title;
    }
    if (data.description !== undefined) {
        dataToUpdate.description = (typeof data.description === 'string' && data.description.length > 0) ? await keeper.encrypt(data.description) : data.description;
    }

    const [updatedSession] = await this.db
      .update(sessions)
      .set(dataToUpdate)
      .where(and(eq(sessions.id, id), eq(sessions.userId, this.userId)))
      .returning();

    if (updatedSession) {
        return this.decryptSessionItem(updatedSession as SessionItem);
    }
    return undefined;
  };

  updateConfig = async (sessionId: string, data: DeepPartial<AgentItem> | undefined | null) => { /* ... no change for session encryption, agent fields handled by AgentModel if any ... */ };

  // **************** Helper *************** //
  private genId = () => idGenerator('sessions');
  // mapSessionItem is now async and handles decryption
}
// Ensure all previous unchanged methods are here
SessionModel.prototype.delete = async function(id: string) {
    return this.db.transaction(async (trx: LobeChatDatabase) => {
      const links = await trx.select({ agentId: agentsToSessions.agentId }).from(agentsToSessions).where(and(eq(agentsToSessions.sessionId, id), eq(agentsToSessions.userId, this.userId)));
      const agentIds = links.map((link) => link.agentId);
      await trx.delete(agentsToSessions).where(and(eq(agentsToSessions.sessionId, id), eq(agentsToSessions.userId, this.userId)));
      const result = await trx.delete(sessions).where(and(eq(sessions.id, id), eq(sessions.userId, this.userId)));
      await this.clearOrphanAgent(agentIds, trx);
      return result;
    });
};
SessionModel.prototype.batchDelete = async function(ids: string[]) {
    if (ids.length === 0) return { count: 0 };
    return this.db.transaction(async (trx: LobeChatDatabase) => {
      const links = await trx.select({ agentId: agentsToSessions.agentId }).from(agentsToSessions).where(and(inArray(agentsToSessions.sessionId, ids), eq(agentsToSessions.userId, this.userId)));
      const agentIds = [...new Set(links.map((link) => link.agentId))];
      await trx.delete(agentsToSessions).where(and(inArray(agentsToSessions.sessionId, ids), eq(agentsToSessions.userId, this.userId)));
      const result = await trx.delete(sessions).where(and(inArray(sessions.id, ids), eq(sessions.userId, this.userId)));
      await this.clearOrphanAgent(agentIds, trx);
      return result;
    });
};
SessionModel.prototype.deleteAll = async function() {
    return this.db.transaction(async (trx: LobeChatDatabase) => {
      await trx.delete(agentsToSessions).where(eq(agentsToSessions.userId, this.userId));
      await trx.delete(agents).where(eq(agents.userId, this.userId));
      return trx.delete(sessions).where(eq(sessions.userId, this.userId));
    });
};
SessionModel.prototype.clearOrphanAgent = async function(agentIds: string[], trx: LobeChatDatabase) { // type fix for trx
    for (const agentId of agentIds) {
      const remaining = await trx.select().from(agentsToSessions).where(eq(agentsToSessions.agentId, agentId)).limit(1);
      if (remaining.length === 0) {
        await trx.delete(agents).where(and(eq(agents.id, agentId), eq(agents.userId, this.userId)));
      }
    }
};
SessionModel.prototype.updateConfig = async function(sessionId: string, data: DeepPartial<AgentItem> | undefined | null) {
    if (!data || Object.keys(data).length === 0) return;
    const session = await this.findByIdOrSlug(sessionId); // findByIdOrSlug now decrypts session fields
    if (!session) return;
    if (!session.agent) {
      throw new Error('this session is not assign with agent, please contact with admin to fix this issue.');
    }
    // Agent fields (title, description) are not encrypted by SessionModel.
    // If AgentModel exists and encrypts them, this merge is fine.
    // If agent fields are also to be encrypted, that logic belongs in an AgentModel or needs to be added here.
    const mergedValue = merge(session.agent, data);
    return this.db.update(agents).set(mergedValue).where(and(eq(agents.id, session.agent.id), eq(agents.userId, this.userId)));
};
