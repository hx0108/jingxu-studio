import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { createQueryClient } from './lib/query-client';
import './styles.css';

const rootElement = document.querySelector<HTMLDivElement>('#root');
if (rootElement === null) {
  throw new Error('Renderer root element is missing.');
}

const queryClient = createQueryClient();

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
