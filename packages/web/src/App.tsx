import type React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { HomePage } from './pages/HomePage.js';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <HomePage />
      <Toaster richColors position="bottom-right" />
    </QueryClientProvider>
  );
}
