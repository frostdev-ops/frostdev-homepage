import type { APIRoute } from 'astro';
import { getUser, setUserRole, setUserPassword, deleteUser, generatePassword } from '../../../lib/users.ts';
import { sessionId, type Role } from '../../../lib/auth.ts';
import { setSetting } from '../../../lib/settings.ts';

export const prerender = false;

// Forms can't PATCH/DELETE; one POST with an action switch keeps the admin
// page dependency-free. Guards (last admin, last user) throw → err redirect.
export const POST: APIRoute = async ({ params, request, cookies, redirect }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || !getUser(id)) return redirect('/admin/users?err=missing', 303);

  const form = await request.formData();
  const action = String(form.get('action') ?? '');

  try {
    switch (action) {
      case 'role': {
        const role = String(form.get('role')) as Role;
        if (role !== 'admin' && role !== 'member') return redirect('/admin/users?err=bad-role', 303);
        setUserRole(id, role);
        return redirect('/admin/users?ok=role', 303);
      }
      case 'reset-password': {
        const password = generatePassword();
        setUserPassword(id, password);
        setSetting(`flash_pw:${sessionId(cookies)}`, password);
        return redirect('/admin/users?ok=reset', 303);
      }
      case 'delete': {
        deleteUser(id);
        return redirect('/admin/users?ok=deleted', 303);
      }
      default:
        return redirect('/admin/users?err=bad-action', 303);
    }
  } catch (err) {
    return redirect(`/admin/users?err=${encodeURIComponent((err as Error).message)}`, 303);
  }
};
