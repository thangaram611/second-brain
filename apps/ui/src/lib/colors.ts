import type { EntityType, RelationType } from './types.js';

export const ENTITY_COLORS: Record<EntityType, string> = {
  concept: '#6366f1',     // indigo
  decision: '#f59e0b',    // amber
  pattern: '#8b5cf6',     // violet
  person: '#10b981',      // emerald
  file: '#64748b',        // slate
  symbol: '#06b6d4',      // cyan
  event: '#ef4444',       // red
  tool: '#f97316',        // orange
  fact: '#3b82f6',        // blue
  conversation: '#ec4899', // pink
  reference: '#84cc16',   // lime
};

export const ENTITY_BG_CLASSES: Record<EntityType, string> = {
  concept: 'bg-indigo-500/20 text-indigo-300',
  decision: 'bg-amber-500/20 text-amber-300',
  pattern: 'bg-violet-500/20 text-violet-300',
  person: 'bg-emerald-500/20 text-emerald-300',
  file: 'bg-slate-500/20 text-slate-300',
  symbol: 'bg-cyan-500/20 text-cyan-300',
  event: 'bg-red-500/20 text-red-300',
  tool: 'bg-orange-500/20 text-orange-300',
  fact: 'bg-blue-500/20 text-blue-300',
  conversation: 'bg-pink-500/20 text-pink-300',
  reference: 'bg-lime-500/20 text-lime-300',
};

export const RELATION_COLORS: Record<RelationType, string> = {
  relates_to: '#94a3b8',
  depends_on: '#ef4444',
  implements: '#6366f1',
  supersedes: '#f59e0b',
  contradicts: '#dc2626',
  derived_from: '#8b5cf6',
  authored_by: '#10b981',
  decided_in: '#f97316',
  uses: '#3b82f6',
  tests: '#06b6d4',
  contains: '#64748b',
  co_changes_with: '#84cc16',
  preceded_by: '#a855f7',
  blocks: '#f43f5e',
};
