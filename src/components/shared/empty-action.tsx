import Link from 'next/link';
import { ArrowRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The button inside an empty state.
 *
 * List screens are rendered by client components, but whether a person may
 * create the thing the list is empty of is a server decision — so the server
 * page builds this and passes it down as a node.
 */
export function EmptyAction({
  href,
  label,
  tone = 'create',
}: {
  href: string;
  label: string;
  /** `create` starts a new record; `go` sends the user to the screen that does. */
  tone?: 'create' | 'go';
}) {
  return (
    <Button asChild variant={tone === 'create' ? 'primary' : 'outline'}>
      <Link href={href}>
        {tone === 'create' ? <Plus /> : null}
        {label}
        {tone === 'go' ? <ArrowRight /> : null}
      </Link>
    </Button>
  );
}
