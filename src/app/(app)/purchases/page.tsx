import type { Metadata } from 'next'
import { PurchasesView } from '@/components/purchases/purchases-view'

export const metadata: Metadata = { title: 'Purchases' }

export default function PurchasesPage() {
  return <PurchasesView />
}
