/** Main-process file selection boundary for existing script imports. */
export interface ScriptInputFile {
  readonly content: string;
  readonly fileName: string;
  readonly inputKind: 'TXT' | 'MARKDOWN';
  readonly encoding: 'UTF-8';
}

export interface ScriptInputFilePort {
  readSelectedText(): Promise<ScriptInputFile | null>;
}
