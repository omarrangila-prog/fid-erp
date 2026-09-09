'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Dashboard charts.
 *
 * Every series arrives pre-formatted from the server as plain numbers and
 * strings — no Decimal ever crosses into the client bundle. Colours come from
 * the same restrained palette as the rest of the interface.
 */

// Charts read from the same palette as everything else. Kept as literals
// because Recharts paints to SVG attributes, which cannot take CSS variables.
const FOREST = '#274f3f';
const FOREST_LIGHT = '#649a81';
const GOLD = '#b47d20';
const AMBER = '#d97706';
const RED = '#dc2626';
const SKY = '#0284c7';
const EMERALD = '#047857';

const AXIS = { stroke: '#8a8478', fontSize: 11 } as const;
const GRID = { stroke: '#e8e4dc', strokeDasharray: '3 3' } as const;

function money(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

/**
 * Recharts hands the formatter a loose union that may be undefined; these
 * helpers narrow it once so each chart can stay readable.
 */
type RcValue = number | string | ReadonlyArray<number | string> | undefined;
type RcName = number | string | undefined;

const asNumber = (value: RcValue) => Number(Array.isArray(value) ? value[0] : (value ?? 0));

const formatUsd = (value: RcValue, name: RcName): [string, string] => [
  `USD ${asNumber(value).toLocaleString()}`,
  String(name ?? ''),
];

const formatKg = (value: RcValue): [string, string] => [`${asNumber(value).toLocaleString()} KG`, 'Available'];

const formatOutstanding = (value: RcValue): [string, string] => [
  `USD ${asNumber(value).toLocaleString()}`,
  'Outstanding',
];

const formatShipments = (value: RcValue, name: RcName): [string, string] => [
  `${asNumber(value)} shipment${asNumber(value) === 1 ? '' : 's'}`,
  String(name ?? ''),
];

const tooltipStyle = {
  contentStyle: {
    borderRadius: '0.5rem',
    border: '1px solid #e8e4dc',
    fontSize: '12px',
    boxShadow: '0 4px 12px rgba(20,32,58,0.08)',
  },
  labelStyle: { fontWeight: 600, color: '#22201c' },
} as const;

export type MonthPoint = { month: string; revenue: number; grossProfit: number; netProfit: number };

export function ProfitTrendChart({ data }: { data: MonthPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={FOREST} stopOpacity={0.18} />
            <stop offset="100%" stopColor={FOREST} stopOpacity={0.01} />
          </linearGradient>
          <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={EMERALD} stopOpacity={0.22} />
            <stop offset="100%" stopColor={EMERALD} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="month" {...AXIS} tickLine={false} axisLine={false} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={money} width={52} />
        <Tooltip {...tooltipStyle} formatter={formatUsd} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={7} />
        <Area type="monotone" dataKey="revenue" name="Revenue" stroke={FOREST} fill="url(#revenueFill)" strokeWidth={2} />
        <Area
          type="monotone"
          dataKey="grossProfit"
          name="Gross Profit"
          stroke={EMERALD}
          fill="url(#profitFill)"
          strokeWidth={2}
        />
        <Area type="monotone" dataKey="netProfit" name="Net Profit" stroke={AMBER} fill="transparent" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export type AgeingPoint = { label: string; amount: number };

export function AgeingChart({ data, tone = 'receivable' }: { data: AgeingPoint[]; tone?: 'receivable' | 'payable' }) {
  const colours =
    tone === 'receivable'
      ? [EMERALD, SKY, AMBER, '#ea580c', RED]
      : [FOREST, FOREST_LIGHT, AMBER, '#ea580c', RED];

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} interval={0} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={money} width={52} />
        <Tooltip {...tooltipStyle} formatter={formatOutstanding} />
        <Bar dataKey="amount" radius={[4, 4, 0, 0]} maxBarSize={56}>
          {data.map((_, index) => (
            <Cell key={index} fill={colours[index % colours.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export type StockPoint = { label: string; kg: number };

export function StockByItemChart({ data }: { data: StockPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid {...GRID} horizontal={false} />
        <XAxis type="number" {...AXIS} tickLine={false} axisLine={false} tickFormatter={money} />
        <YAxis type="category" dataKey="label" {...AXIS} tickLine={false} axisLine={false} width={150} />
        <Tooltip {...tooltipStyle} formatter={formatKg} />
        <Bar dataKey="kg" fill={EMERALD} radius={[0, 4, 4, 0]} maxBarSize={20} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export type StatusPoint = { label: string; value: number };

const STATUS_COLOURS = [FOREST, '#427c62', SKY, AMBER, GOLD, FOREST_LIGHT, '#96bda9', '#c2d9cc', '#e0ece5'];

export function ShipmentStatusChart({ data }: { data: StatusPoint[] }) {
  if (data.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          innerRadius={54}
          outerRadius={86}
          paddingAngle={2}
          strokeWidth={0}
        >
          {data.map((_, index) => (
            <Cell key={index} fill={STATUS_COLOURS[index % STATUS_COLOURS.length]} />
          ))}
        </Pie>
        <Tooltip {...tooltipStyle} formatter={formatShipments} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={7} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function PurchaseVsSalesChart({
  data,
}: {
  data: Array<{ month: string; purchases: number; sales: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="month" {...AXIS} tickLine={false} axisLine={false} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={money} width={52} />
        <Tooltip {...tooltipStyle} formatter={formatUsd} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={7} />
        <Bar dataKey="purchases" name="Purchases" fill={FOREST} radius={[3, 3, 0, 0]} maxBarSize={18} />
        <Bar dataKey="sales" name="Sales" fill={EMERALD} radius={[3, 3, 0, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
