# Data Model Reference

## Entity Types (15)
concept, decision, pattern, person, file, symbol, event, tool, fact, conversation, reference, implementation, pull_request, merge_request, branch

## Relation Types (20)
relates_to, depends_on, implements, supersedes, contradicts, derived_from, authored_by, decided_in, uses, tests, contains, co_changes_with, preceded_by, blocks, reviewed_by, merged_in_mr, merged_in_pr, touches_file, owns, parallel_with

## Key Constraints
- Entity ID: ULID. Relation unique: (sourceId, targetId, type)
- batchUpsert dedupes on (name, namespace, type) — merges observations/tags
- Confidence decay: fact=0.01/day, concept=0.005/day, decision=0.003/day. person/file/symbol never decay
- Bitemporal: eventTime (when it happened) + ingestTime (when discovered)
