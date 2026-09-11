import * as NativeAPI from "./native.node";

// All native methods are exposed to the renderer via IPC, so sync methods become
// async. This mapped type wraps every sync return value in Promise<>.
type RendererNativeAPI = {
  [K in keyof typeof NativeAPI]: (typeof NativeAPI)[K] extends (...args: infer A) => infer R
    ? R extends Promise<any>
      ? (...args: A) => R
      : (...args: A) => Promise<R>
    : (typeof NativeAPI)[K];
};

declare global {
  interface Window {
    wcash: {
      readonly config: {
        readonly productName: string;
        readonly network: string;
        readonly ticker: string;
        readonly runtimeReady: boolean;
        readonly coreRevision: string | null;
      };
      status: () => Promise<unknown>;
      create: () => Promise<unknown>;
      restore: (seedPhrase: string, birthdayHeight: number) => Promise<unknown>;
      resumePending: () => Promise<unknown>;
      revealBackup: () => Promise<unknown>;
      acknowledgeBackup: () => Promise<unknown>;
      open: () => Promise<unknown>;
      sync: () => Promise<unknown>;
      stopSync: () => Promise<boolean>;
      balance: () => Promise<unknown>;
      receivers: () => Promise<unknown>;
      validateRecipient: (address: string) => Promise<unknown>;
      send: (request: unknown) => Promise<unknown>;
      shieldCoinbase: () => Promise<unknown>;
      pendingTransactions: (afterCursor?: string) => Promise<unknown>;
      rebroadcastPending: (txid: string) => Promise<unknown>;
    };
    wcashShell: {
      readonly productName: "Wcash Warden Testnet";
      readonly network: "Wcash Testnet";
      readonly ticker: "TWC";
      readonly runtimeReady: false;
      readonly coreRevision: null;
    };
    electronAPI: {
      native: RendererNativeAPI;
      isSandboxed: boolean;
      clipboard: {
        writeText: (text: string) => void;
      };
      shell: {
        openExternal: (url: string) => void;
      };
      ipcRenderer: {
        on: (channel: string, listener: (...args: any[]) => void) => void;
        off: (channel: string, listener: (...args: any[]) => void) => void;
        removeListener: (channel: string, listener: (...args: any[]) => void) => void;
        invoke: (channel: string, ...args: any[]) => Promise<any>;
        send: (channel: string, ...args: any[]) => void;
      };
      fs: {
        existsSync: (path: string) => Promise<boolean>;
        promises: {
          mkdir: (path: string, options?: any) => Promise<void>;
          writeFile: (path: string, data: string) => Promise<void>;
          readFile: (path: string) => Promise<string>;
        };
      };
    };
  }
}
