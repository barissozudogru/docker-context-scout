export interface FileEntry {
  path: string;
  size: number;
  isDirectory: boolean;
}

export interface PatternSuggestion {
  pattern: string;
  reason: string;
  estimatedSavingsBytes: number;
}

export interface AnalysisResult {
  totalSizeBytes: number;
  totalSizeMB: number;
  fileCount: number;
  topOffenders: FileEntry[];
  existingDockerignoreRules: string[];
  suggestedRules: PatternSuggestion[];
  estimatedReducedSizeBytes: number;
  estimatedReducedSizeMB: number;
  reductionPercentage: number;
  analyzedPath: string;
}
