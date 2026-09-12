import type { Metadata } from 'next'
import { CustomerDetailView } from '@/components/customers/customer-detail-view'

export const metadata: Metadata = { title: 'Customer' }

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <CustomerDetailView customerId={id} />
}
