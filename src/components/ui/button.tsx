'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium',
    'transition-[background-color,border-color,color,box-shadow,transform] duration-150',
    'disabled:pointer-events-none disabled:opacity-50',
    'active:translate-y-px',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        // Forest is the workhorse; gold is saved for the one action on a screen
        // that deserves the eye. gold-700 rather than gold-600 so white text
        // clears the AA contrast threshold.
        primary: 'bg-forest-800 text-white shadow-card hover:bg-forest-700 active:bg-forest-900',
        accent: 'bg-gold-700 text-white shadow-card hover:bg-gold-800 active:bg-gold-900',
        outline: 'border border-line-strong bg-surface text-ink hover:border-forest-300 hover:bg-forest-50',
        ghost: 'text-ink-muted hover:bg-forest-50 hover:text-ink',
        danger: 'bg-red-600 text-white shadow-card hover:bg-red-700 active:bg-red-800',
        subtle: 'bg-forest-100 text-forest-800 hover:bg-forest-200',
        link: 'text-forest-700 underline-offset-4 hover:underline hover:text-forest-800',
      },
      size: {
        // Coarse pointers get a 44px target regardless of the visual height.
        sm: 'h-8 px-3 text-xs [@media(pointer:coarse)]:min-h-11',
        md: 'h-10 px-4 [@media(pointer:coarse)]:min-h-11',
        lg: 'h-11 px-6',
        icon: 'h-9 w-9 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="animate-spin" aria-hidden />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
