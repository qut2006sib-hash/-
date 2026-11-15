import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Welcome from '@/pages/welcome';
import PassengerPage from '@/pages/passenger';
import HistoryPage from '@/pages/history';
import DriverPage from '@/pages/driver';
import AdminPage from '@/pages/admin';
import RequestDetailPage from '@/pages/request-detail';
import { OfflineBanner } from '@/components/shell';
import { setReplayHandler } from '@workspace/api-client-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true, refetchOnReconnect: true, refetchIntervalInBackground: true, retry: 1 },
  },
});
setReplayHandler(async () => {
  await queryClient.invalidateQueries({}, { throwOnError: true });
});

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Welcome} />
        <Route path="/passenger" component={PassengerPage} />
        <Route path="/passenger/history" component={HistoryPage} />
        <Route path="/driver" component={DriverPage} />
        <Route path="/admin" component={AdminPage} />
        <Route path="/requests/:id" component={RequestDetailPage} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <OfflineBanner />
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
