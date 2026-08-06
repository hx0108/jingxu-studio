import { contextBridge } from 'electron';

import { createJingxuApi } from './jingxu-api';

contextBridge.exposeInMainWorld('jingxu', createJingxuApi());
