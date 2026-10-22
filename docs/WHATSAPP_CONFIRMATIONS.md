# WhatsApp complaint confirmations

The application uses the Meta WhatsApp Cloud API. Actual sending is disabled by default. No historical complaints are enrolled or sent automatically.

## Connect

1. Connect an approved WhatsApp Business sender in your Meta app. Store a system-user access token with WhatsApp messaging permission, the sender phone-number ID, app secret and a webhook verification token in the server environment. Do not enter tokens into source control or chat.
2. Set `APP_ORIGIN` to the hosted, public HTTPS CRM address. Localhost links cannot be used by customers.
3. Create and approve the Arabic **UTILITY** template `aliz_complaint_received` with **NAMED** parameters, using the body below. Set `WHATSAPP_TEMPLATE_NAME` if you use a different name; its fields must match exactly.
4. Configure the callback URL `https://YOUR_CRM/api/integrations/whatsapp/webhook`. Verify it using `WHATSAPP_VERIFY_TOKEN` and subscribe to `messages`. The CRM checks the HMAC SHA-256 signature on the original request body and matches the sender and recipient before accepting delivery updates.
5. Set the variables listed in `.env.example`, including `WHATSAPP_TEMPLATE_APPROVED=true` and `WHATSAPP_ENABLED=true`, then restart the API and worker. Settings → WhatsApp confirmation shows readiness and delivery counts without exposing secrets.
6. Submit a complaint using a number you own, check the WhatsApp opt-in box and verify the delivered status in the CRM. This is a real message and may incur provider charges.

## Approved template body

```text
تم استلام شكواك {{number}}.
العلامة: {{brand}}
الفرع: {{branch}}
وقت الاستقبال (الرياض): {{received_at}}
التصنيف: {{category}}
رقم الطلب: {{order}}
تفاصيل المشكلة: {{summary}}
للتفاصيل الكاملة ومتابعة الشكوى:
{{tracking_url}}
```

Provide synthetic examples for all eight named parameters when submitting the template. The summary is limited to 180 characters because Meta limits utility-template bodies to 1024 characters. The private receipt link contains the full submitted description, customer name if supplied, category, brand, branch, intake time, order reference and platform. Internal notes, agent names, financial processing and customer attachments are not published by the tracking endpoint. A tracking link is a bearer credential and expires after 30 days.

## Delivery behavior

- Phone and affirmative WhatsApp consent are required to request a confirmation. Phone complaints use an agent checkbox recording the customer's consent. Without consent, a complaint still saves normally.
- A confirmation is inserted in the complaint's database transaction, with one unique row per complaint. Phone, receipt and description are encrypted at rest. Replaying the same idempotency key returns the same receipt and does not enqueue another confirmation.
- The worker checks the queue every 10 seconds. HTTP acceptance means **ACCEPTED**, not delivered. Verified callbacks advance the record to **SENT**, **DELIVERED** or **READ**; callbacks cannot move a delivered/read message backwards.
- Explicit HTTP 429 responses retry up to 3 attempts with backoff. Queued confirmations expire after one hour. Network timeouts or ambiguous outcomes become **UNKNOWN** and are not automatically resent, to avoid duplicate messages. A late signed callback can resolve an unknown outcome.
- At most five confirmations are queued for one phone number per hour. No customer details, provider error bodies, tokens or tracking URLs are logged.
- If configuration is unavailable at intake, the complaint and its receipt still save. There is no false “message sent” claim and no delayed historical-send backlog.

## Official references

- [Meta utility template sending](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates)
- [Webhook endpoint verification and signatures](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/)
- [Delivery status webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)
