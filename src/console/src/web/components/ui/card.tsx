import type { HTMLAttributes } from 'react';

export function Card(props: HTMLAttributes<HTMLDivElement>) {
  const { className = '', ...rest } = props;
  return <section className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`} {...rest} />;
}

export function CardTitle(props: HTMLAttributes<HTMLHeadingElement>) {
  const { className = '', ...rest } = props;
  return <h2 className={`mb-3 text-lg font-semibold text-slate-950 ${className}`} {...rest} />;
}

export function CardDescription(props: HTMLAttributes<HTMLParagraphElement>) {
  const { className = '', ...rest } = props;
  return <p className={`mb-4 text-sm text-slate-600 ${className}`} {...rest} />;
}
