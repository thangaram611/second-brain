export {
  DEFAULT_DENY_GLOBS,
  DEFAULT_DENY_DIRS,
  filterNoise,
  isDeniedByGlobs,
} from './noise-filter.js';
export type { NoiseFilterOptions } from './noise-filter.js';

export {
  createBranchTracker,
  readHead,
  resolveGitDir,
} from './branch-tracker.js';
export type {
  BranchTrackerOptions,
  BranchTrackerHandle,
  BranchChangeEvent,
} from './branch-tracker.js';

export { startFileChangeCollector } from './file-change-collector.js';
export type {
  FileChangeCollectorOptions,
  FileChangeCollectorHandle,
} from './file-change-collector.js';
