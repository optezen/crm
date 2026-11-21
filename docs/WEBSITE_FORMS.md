# Website Forms: connection guide

Send leads from a website form into Optizen. Works with WordPress (Contact Form 7, WPForms, Gravity Forms, Elementor), Next.js and any server. A lead appears in **Leads**, runs your automations and is scoped to the workspace that owns the connection. Nothing in the request can choose a different workspace.

> Status: the receiving side (authentication, idempotency, mapping, diagnostics) is implemented and covered by offline tests. The WordPress/Elementor snippets below are written from those plugins' documented hooks and are **not tested against live plugin installs**: run the "Test it" step once per site.

## 1. Create the connection (once per website)

1. Builder → **Connections** → Website Forms → **Create connection**. Give it the site's name.
2. Copy the **webhook URL** (use the Copy button) and the **secret**. The secret is shown **once**; only its hash is stored. Lost it? **Rotate** the secret (the old one stops working immediately).
3. Keep the secret on the server (environment variable, WordPress `wp-config.php` constant). Never put it in browser JavaScript, theme files that are public, or a page builder field that is rendered to visitors.

## 2. How the request must look

| Item | Value |
|---|---|
| Method / URL | `POST https://<your-optizen-domain>/api/webhooks/forms/<public_id>` |
| Credential | `Authorization: Bearer <secret>` (preferred) or `X-Optizen-Key: <secret>` |
| Body | `application/json` or `application/x-www-form-urlencoded` (PHP-style `fields[email]` is understood), max 20 KB, max 60 fields |
| `Idempotency-Key` | Any unique id per submission (entry id). Send the **same** key when retrying so a lead is never created twice |
| Needs | a phone **or** an email (otherwise 422) |

Responses: `201` created · `200` duplicate (already received) · `422` rejected (no usable phone/email) · `400` malformed body · `401` wrong or missing credential (or URL credentials not allowed) · `429` rate limited (`Retry-After`) · `503` temporarily unavailable, retry with the same `Idempotency-Key`.

There are no CORS headers on purpose: browsers cannot post directly. Always send from the server.

### URL credentials (`?key=`)
Refused by default because a credential in a URL leaks into server logs, browser history and referrers. Enable **Allow the credential in the URL** on that connection only for a tool that cannot set headers (Elementor's built-in Webhook action). The screen warns when it is on; rotate the secret regularly and prefer the header methods below.

## 3. WordPress

Put the two values in `wp-config.php` (outside the web root's public files):

```php
define('OPTIZEN_FORM_URL', 'https://YOUR-APP/api/webhooks/forms/<public_id>');
define('OPTIZEN_FORM_SECRET', '<secret>');
```

Add this helper to a small must-use plugin (`wp-content/mu-plugins/optizen.php`) or your child theme's `functions.php`:

```php
<?php
function optizen_send(array $fields, string $idempotency_key): void {
  $res = wp_remote_post(OPTIZEN_FORM_URL, [
    'timeout' => 8,
    'headers' => [
      'Authorization'   => 'Bearer ' . OPTIZEN_FORM_SECRET,
      'Content-Type'    => 'application/json',
      'Idempotency-Key' => $idempotency_key,
    ],
    'body' => wp_json_encode($fields),
  ]);
  $code = is_wp_error($res) ? 0 : wp_remote_retrieve_response_code($res);
  if ($code === 201 || $code === 200) return;                       // created or already received
  error_log('Optizen form delivery failed: HTTP ' . $code);          // never log the secret or the lead
  if ($code === 0 || $code >= 500 || $code === 429) {                // transient: retry once in 5 minutes with the SAME key
    wp_schedule_single_event(time() + 300, 'optizen_retry', [$fields, $idempotency_key]);
  }
}
add_action('optizen_retry', 'optizen_send', 10, 2);
```

### Elementor (Pro forms): recommended, header-based
Elementor's Webhook action cannot set headers, so hook the form instead. Replace `contact` with your form's **Form Name** (Elementor → form → Settings → Form Name) so other forms are not sent:

```php
add_action('elementor_pro/forms/new_record', function ($record, $handler) {
  if ($record->get_form_settings('form_name') !== 'contact') return;
  $fields = [];
  foreach ($record->get('fields') as $id => $f) { $fields[$id] = $f['value']; }   // id => submitted value
  $fields['page_url'] = $_POST['referrer'] ?? '';
  optizen_send($fields, 'elementor-' . $record->get_form_settings('id') . '-' . wp_generate_uuid4());
}, 10, 2);
```
Name your Elementor field ids `name`, `email`, `phone`, `message` and they map automatically. (The uuid makes each submission unique; the same key is reused only by the retry.)

### Elementor: Webhook action (only if you cannot add code)
1. In Optizen enable **Allow the credential in the URL** on the connection.
2. Form → Actions After Submit → **Webhook** → URL: `https://YOUR-APP/api/webhooks/forms/<public_id>?key=<secret>`.
3. Treat that URL as a secret. Rotate the secret if the URL is ever shared. There is no retry and no idempotency key in this mode; Optizen still ignores an identical payload that was already processed in the last 24 hours.

### Contact Form 7
```php
add_action('wpcf7_mail_sent', function ($form) {
  $sub = WPCF7_Submission::get_instance(); if (!$sub) return;
  $d = $sub->get_posted_data();
  optizen_send([
    'name' => $d['your-name'] ?? '', 'email' => $d['your-email'] ?? '', 'phone' => $d['your-phone'] ?? '',
    'message' => $d['your-message'] ?? '', 'page_url' => $sub->get_meta('url'),
  ], 'cf7-' . $form->id() . '-' . wp_generate_uuid4());
});
```

### WPForms
```php
add_action('wpforms_process_complete', function ($fields, $entry, $form_data, $entry_id) {
  $out = [];
  foreach ($fields as $f) { $out[sanitize_title($f['name'])] = $f['value']; }   // "Your Name" -> your-name, mapped automatically
  optizen_send($out, 'wpforms-' . $form_data['id'] . '-' . $entry_id);
}, 10, 4);
```

### Gravity Forms
```php
add_action('gform_after_submission', function ($entry, $form) {
  $out = [];
  foreach ($form['fields'] as $f) { $out[sanitize_title($f->label)] = rgar($entry, (string) $f->id); }
  optizen_send($out, 'gf-' . $form['id'] . '-' . $entry['id']);
}, 10, 2);
```

## 4. Next.js (server action or route handler)
Environment variables (`.env.local` / hosting dashboard, **not** `NEXT_PUBLIC_*`): `OPTIZEN_FORM_URL`, `OPTIZEN_FORM_SECRET`.

```ts
// app/actions/contact.ts
'use server';
import { randomUUID } from 'node:crypto';

export async function submitContact(_: unknown, form: FormData) {
  const body = {
    name: String(form.get('name') ?? ''), email: String(form.get('email') ?? ''), phone: String(form.get('phone') ?? ''),
    message: String(form.get('message') ?? ''), utm_source: String(form.get('utm_source') ?? ''), page_url: String(form.get('page_url') ?? ''),
  };
  if (!body.email && !body.phone) return { ok: false, error: 'Please enter a phone number or an email.' };
  const key = String(form.get('submission_id') ?? randomUUID());       // generate once when the form renders so a double-click re-uses it
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(process.env.OPTIZEN_FORM_URL!, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${process.env.OPTIZEN_FORM_SECRET}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(body),
      });
      if (res.status === 201 || res.status === 200) return { ok: true };
      if (res.status === 422) return { ok: false, error: 'We need a valid phone number or email.' };
      if (res.status !== 429 && res.status < 500) { console.error('Optizen rejected the form: HTTP', res.status); break; }  // 400/401: a code problem, retrying will not help
    } catch { /* network error: retry */ }
    await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
  }
  return { ok: false, error: 'Something went wrong. Please try again.' };
}
```

## 5. Any server (curl)
```bash
curl -i -X POST "https://YOUR-APP/api/webhooks/forms/<public_id>" \
  -H "Authorization: Bearer <secret>" -H "Content-Type: application/json" -H "Idempotency-Key: test-1" \
  -d '{"name":"Test Person","email":"test@example.com","phone":"+919845012345","message":"Hello","utm_source":"manual-test"}'
```

## 6. Test it
Run the curl command above once with a fresh `Idempotency-Key`: expect `201` and a lead in **Leads**. Run it again with the same key: expect `200 duplicate` and no second lead. Then submit the real form once and confirm the lead and its source/UTM details.

## 7. Field mapping
Common names map automatically (name / full name / your-name, first/last name, phone / mobile / whatsapp, email / your-email, message / comments / enquiry; `utm_*`, `gclid`, `fbclid` are kept as attribution). For anything else open the connection → **Field mapping**: Optizen lists the field names it has actually received, and you choose a CRM target per field (or *Ignore*). Unmapped fields are kept in the lead summary, so nothing is silently dropped. Mapping changes apply to **new** submissions. A phone that cannot be parsed is kept in the summary with a warning and the lead is still created if an email exists.

## 8. Diagnostics: what went wrong?
Open the connection card: *Last event*, *Last 24h: received / leads / rejected*, and *Last problem*. Operations (Builder → Operations) lists recent integration errors. Messages never include the secret or the submitted personal data.

| Symptom | Cause | Fix |
|---|---|---|
| `401` | wrong/rotated secret, header missing, or `?key=` used while URL credentials are off | re-copy the secret; send the header; or enable URL credentials knowingly |
| `422` | no valid phone or email in the submission | add a phone/email field; check the field names against the mapping screen |
| `400` | not JSON/urlencoded, over 20 KB, or more than 60 fields | send a flat set of fields |
| `429` | more than the connection's per-minute limit | slow down or raise the limit on the connection; retry after `Retry-After` |
| `503` | temporary outage | retry with the **same** `Idempotency-Key` |
| Lead missing, no error | form hook not firing (wrong Form Name / action) or the site blocks outbound requests | check `error_log`; test with curl from the same server |

## 9. Security notes
- Rotate the secret if it was ever pasted into a chat, ticket or browser; rotation invalidates the old value immediately.
- Each connection is bound to one workspace. A leaked secret can only create leads in that workspace, never read anything.
- Submissions are validated, size-limited and rate-limited; IP addresses are not stored.
