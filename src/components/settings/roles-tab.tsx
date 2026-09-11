'use client'

import * as React from 'react'
import { Check, Minus, ShieldCheck } from 'lucide-react'
import type { AppPermission, RolePermission, UserRole } from '@/types/database'
import { ROLE_LABELS, ROLE_ORDER, ALL_PERMISSIONS, PERMISSION_LABELS } from '@/lib/auth/constants'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

/**
 * Read-only role × permission matrix (foundation).
 * Values come from the role_permissions table; granular editing arrives in a
 * later phase. The source of truth for enforcement is the database
 * (has_app_permission + RLS policies), not this view.
 */
export function RolesTab({ rolePermissions }: { rolePermissions: RolePermission[] }) {
  const grants = React.useMemo(() => {
    const map = new Map<string, Set<AppPermission>>()
    for (const { role, permission } of rolePermissions) {
      if (!map.has(role)) map.set(role, new Set())
      map.get(role)!.add(permission)
    }
    return map
  }, [rolePermissions])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4.5 text-primary" aria-hidden="true" />
          Roles &amp; permissions
        </CardTitle>
        <CardDescription>
          What each role can do. Enforced at the database level (row-level security), not just in
          the interface. Granular per-role editing arrives in a later phase.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="thin-scrollbar overflow-x-auto rounded-md border">
          <Table className="min-w-[46rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card">Permission</TableHead>
                {ROLE_ORDER.map((role) => (
                  <TableHead key={role} className="min-w-[7.5rem] text-center">
                    <span className="inline-flex flex-col items-center gap-1">
                      <span>{ROLE_LABELS[role]}</span>
                      {role === 'admin' ? (
                        <Badge variant="default" className="text-[10px]">
                          full access
                        </Badge>
                      ) : null}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ALL_PERMISSIONS.map((permission) => (
                <TableRow key={permission}>
                  <TableCell className="sticky left-0 z-10 bg-card text-[13px] font-medium">
                    {PERMISSION_LABELS[permission]}
                  </TableCell>
                  {ROLE_ORDER.map((role) => {
                    const granted = grants.get(role)?.has(permission) ?? false
                    return (
                      <TableCell key={role} className="text-center">
                        {granted ? (
                          <span
                            className="inline-flex size-5 items-center justify-center rounded-full bg-success/10 text-success"
                            title={`${ROLE_LABELS[role]}: allowed`}
                          >
                            <Check className="size-3.5" aria-hidden="true" />
                            <span className="sr-only">Allowed</span>
                          </span>
                        ) : (
                          <span
                            className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground/50"
                            title={`${ROLE_LABELS[role]}: not allowed`}
                          >
                            <Minus className="size-3.5" aria-hidden="true" />
                            <span className="sr-only">Not allowed</span>
                          </span>
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
