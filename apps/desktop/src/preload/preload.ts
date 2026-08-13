import { contextBridge, ipcRenderer } from 'electron';

import { createJingxuApi } from './jingxu-api';

contextBridge.exposeInMainWorld(
  'jingxu',
  createJingxuApi((channel, ...arguments_) => ipcRenderer.invoke(channel, ...arguments_)),
);
