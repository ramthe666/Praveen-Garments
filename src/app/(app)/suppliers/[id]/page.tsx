import type { Metadata } from 'next'
import { SupplierDetailView } from '@/components/suppliers/supplier-detail-view'

export const metadata: Metadata = { title: 'Supplier' }

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <SupplierDetailView supplierId={id} />
}
