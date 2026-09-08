import type { InputHTMLAttributes } from 'react';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 ${className}`} {...rest} />;
}
