import { areaY, barX, barY, colorLegend, defineChart, group, lineY, ruleY, stack } from '@tanstack/charts'
import { crosshair } from '@tanstack/charts/crosshair'
import { pie, polar, radialArc } from '@tanstack/charts/polar'
import { Chart } from '@tanstack/charts/react'
import { scaleBand } from '@tanstack/charts/scales/band'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { tooltip } from '@tanstack/charts/tooltip'
import { scaleUtc } from 'd3-scale'
import { useMemo } from 'react'
import { money, moneyCompact, month, number, titleCase } from '../lib/format'

const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const toDate = (ym: string) => new Date(`${ym}-01T00:00:00Z`)

/** Monthly revenue: area + line over a UTC time axis, crosshair + grouped tooltip. */
export function RevenueChart({
  data,
  height = 260,
}: {
  data: ReadonlyArray<{ month: string; revenue: number }>
  height?: number
}) {
  const definition = useMemo(() => {
    const rows = data.map((d) => ({ date: toDate(d.month), revenue: d.revenue }))
    return defineChart({
      marks: [
        ruleY([0], { strokeOpacity: 0.2 }),
        areaY(rows, { x: 'date', y: 'revenue', fill: 'var(--ts-chart-1)', fillOpacity: 0.12 }),
        lineY(rows, { x: 'date', y: 'revenue', stroke: 'var(--ts-chart-1)', strokeWidth: 2, points: true }),
        crosshair({ x: { label: true }, y: false }),
      ],
      scales: {
        x: { scale: scaleUtc, axis: { ticks: { count: 6, format: (d: Date) => monthFmt.format(d) } } },
        y: { scale: scaleLinear, nice: true, grid: true, axis: { ticks: { count: 5, format: (v: number) => moneyCompact(v) } } },
      },
      focus: 'group-x',
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        formatGroup: (points) =>
          points.length ? `${monthFmt.format(points[0]!.datum.date)}\n${money(points[0]!.datum.revenue)}` : '',
      },
    })
  }, [data])
  return (
    <div data-testid="revenue-chart">
      <Chart definition={definition} height={height} ariaLabel="Monthly revenue" />
    </div>
  )
}

/** New signups per month, stacked (or grouped) by plan. */
export function SignupsChart({
  data,
  mode = 'stacked',
  height = 260,
}: {
  data: ReadonlyArray<{ month: string; plan: string; count: number }>
  mode?: 'stacked' | 'grouped'
  height?: number
}) {
  const definition = useMemo(() => {
    const rows = data.map((d) => ({ ...d, label: month(d.month), plan: titleCase(d.plan) }))
    return defineChart({
      marks: [
        barY(rows, {
          x: 'label',
          y: 'count',
          color: 'plan',
          layout: mode === 'grouped' ? group({ padding: 0.1 }) : stack({ order: ['Free', 'Starter', 'Pro', 'Enterprise'] }),
          radius: { end: 3 },
        }),
        ruleY([0]),
      ],
      scales: {
        x: { scale: () => scaleBand<string>().padding(0.25) },
        y: { scale: scaleLinear, nice: true, grid: true },
      },
      color: { domain: ['Free', 'Starter', 'Pro', 'Enterprise'], legend: colorLegend({ label: 'Plan' }) },
      focus: 'group-x',
      tooltip: {
        use: tooltip,
        formatGroup: (points) =>
          [points[0]?.datum.label ?? '', ...points.map((p) => `${p.datum.plan}: ${number(p.datum.count)}`)].join('\n'),
      },
    })
  }, [data, mode])
  return (
    <div data-testid="signups-chart">
      <Chart definition={definition} height={height} ariaLabel="New customers per month by plan" />
    </div>
  )
}

/** Donut of a categorical breakdown. */
export function DonutChart({
  data,
  label,
  height = 240,
  format = number,
}: {
  data: ReadonlyArray<{ key: string; value: number }>
  label: string
  height?: number
  format?: (n: number) => string
}) {
  const definition = useMemo(() => {
    const rows = data.map((d) => ({ label: titleCase(d.key), value: d.value }))
    const slices = pie(rows, { value: 'value' })
    return defineChart({
      marks: [
        polar({
          inset: 8,
          radiusRatio: 0.9,
          marks: [
            radialArc(slices, { innerRadius: ({ radius }) => radius * 0.62, cornerRadius: 3, color: 'label', key: 'label' }),
          ],
          scales: { angle: null, radius: null },
        }),
      ],
      scales: { x: null, y: null },
      color: { domain: rows.map((r) => r.label), legend: colorLegend({ label }) },
      tooltip: { use: tooltip, format: (p) => `${p.datum.label}: ${format(p.datum.value)}` },
    })
  }, [data, label, format])
  return <Chart definition={definition} height={height} ariaLabel={label} />
}

/** Horizontal bars, e.g. MRR by country. */
export function HBarChart({
  data,
  label,
  height = 300,
  format = number,
}: {
  data: ReadonlyArray<{ key: string; value: number }>
  label: string
  height?: number
  format?: (n: number) => string
}) {
  const definition = useMemo(
    () =>
      defineChart({
        marks: [barX([...data], { x: 'value', y: 'key', fill: 'var(--ts-chart-2)', radius: { end: 3 } })],
        scales: {
          x: { scale: scaleLinear, nice: true, grid: true, axis: { ticks: { count: 4, format: (v: number) => format(v) } } },
          y: { scale: () => scaleBand<string>().padding(0.2) },
        },
        focus: 'nearest-y',
        tooltip: { use: tooltip, format: (p) => `${p.datum.key}: ${format(p.datum.value)}` },
      }),
    [data, format],
  )
  return <Chart definition={definition} height={height} ariaLabel={label} />
}
