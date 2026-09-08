/** Separate operator entry for Candy's bounded audit window. */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface AuditWindow { tenant: readonly unknown[]; runtime: readonly unknown[]; retention: number; completeHistory: false }
export type CandyAuditSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.candyAccount'>

export function CandyAuditSection({ t }: CandyAuditSectionProps) {
  const [window, setWindow] = useState<AuditWindow>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    void fetch('/api/candy/audits', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`status ${response.status}`)
        return response.json() as Promise<AuditWindow>
      })
      .then((value) => { if (current) setWindow(value) })
      .catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [])
  return <section>
    <h2>{t('auditTitle')}</h2>
    <p>{t('auditWindow', { retention: window?.retention ?? '…' })}</p>
    {failed ? <p role="alert">{t('auditFailure')}</p> : null}
    {window ? <pre>{JSON.stringify({ tenant: window.tenant, runtime: window.runtime }, null, 2)}</pre> : null}
  </section>
}
