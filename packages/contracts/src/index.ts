export type JingxuApi = Readonly<Record<string, never>>;

declare global {
  interface Window {
    readonly jingxu: JingxuApi;
  }
}
