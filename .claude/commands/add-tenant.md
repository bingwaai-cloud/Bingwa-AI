# Command: /add-tenant

Onboard a new business tenant into Bingwa AI.

## What to do
1. Create record in public.tenants
2. Generate schema name: tenant_{uuid_no_dashes}
3. Create PostgreSQL schema for tenant
4. Run all per-tenant migrations in new schema
5. Create default user_context record
6. Seed common item aliases (sugar, flour, oil, soap, salt)
7. Create free subscription record
8. Send welcome WhatsApp message

## Welcome message template
```
🏆 Welcome to Bingwa AI!
Your business champion is ready.

Let's set you up in 5 quick steps.

Step 1: What is your shop name?
```

## Onboarding steps (WhatsApp conversation)
1. Shop name
2. Main items sold (name, qty, selling price each)
3. Fixed expenses (rent, electricity)
4. Key suppliers (name, phone)
5. First test sale walkthrough

## After onboarding complete
- Set onboarding_complete = true
- Send morning report at 7AM next day
- Add to daily scheduled jobs

## Error handling
- If schema creation fails → rollback tenant record
- If WhatsApp message fails → log but don't fail signup
- Always return tenant ID on success
