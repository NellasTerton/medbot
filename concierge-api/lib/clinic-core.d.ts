// Типы для clinic-core.js, чтобы модуль можно было импортировать из
// TypeScript-проекта mcp-server без дублирования исходников.

export declare const RAG_MATCH_THRESHOLD: number;
export declare const RAG_MATCH_COUNT: number;

export interface KnowledgeDocument {
  id: string;
  content: string;
  similarity: number;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
}

export interface Lead {
  name: string;
  phone: string;
  service: string;
  date: string;
}

export type LeadField = keyof Lead;

export declare function requireEnv(name: string): string;
export declare function getDatabaseUrl(): string;
export declare function hasDatabaseUrl(): boolean;
export declare function fetchJson(
  url: string,
  options: RequestInit,
  label: string,
): Promise<any>;
export declare function embedQuery(message: string): Promise<number[]>;
export declare function expandSearchQuery(message: string): string;
export declare function buildLexicalPatterns(message: string): string[];
export declare function searchKnowledgeBase(
  message: string,
  options?: SearchOptions,
): Promise<KnowledgeDocument[]>;
export declare function normalizeLead(input?: Partial<Lead> | null): Lead;
export declare function missingLeadFields(input?: Partial<Lead> | null): LeadField[];
export declare function isLeadComplete(input?: Partial<Lead> | null): boolean;
export declare function postMakeWebhook(lead: Lead): Promise<void>;
export declare function submitLead(input: Partial<Lead>): Promise<Lead>;
