import { Card, CardDescription, CardHeader, CardTitle } from '@foodstack/ui/components/card';
import { EmptyState } from '@foodstack/ui/components/empty-state';
import { PageHeader } from '@foodstack/ui/layouts/dashboard-shell';
import { LayoutDashboard } from 'lucide-react';
import { ApiStatus } from '@/components/api-status';

const stats = ['Today’s sales', 'Orders', 'Average bill', 'Open tables'];

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Overview of your restaurant performance."
        actions={<ApiStatus />}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((label) => (
          <Card key={label}>
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle className="tabular text-2xl">—</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <EmptyState
        className="mt-6"
        icon={<LayoutDashboard className="size-5" />}
        title="No data yet"
        description="Sales charts and insights will appear here once your restaurant starts billing."
      />
    </>
  );
}
