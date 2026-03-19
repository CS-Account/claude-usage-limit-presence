# Specification

This project is a short, quick Tampermonkey script (primarily targeting Firefox) for `claude.ai`.

The objectives of the script are as follows:
    - Remove the current 75% near usage warning on the chat box itself
    - Use the official API and regular js requests to fetch the current usage stats
    - Display the current usage stats (spend included) on a floating vertical, minimalistic UI element on the right hand side of the page, not moving.
    - Have the usage stats update every 10 minutes or so, without needing to refresh the page
    - Display the last time the usage stats were updated in 24 hour local time, and have a refresh icon button refresh the stats upon clicking the UI element we have added.

## Dependencies

Nothing except built-ins of JS or the Tampermonkey API.

## UI

The UI will be a small vertical capsule on the right center of the page, with a blurred (6px), contrasted background and text that is a contrast color to the background, somewhat similar to Apple "Glass" design elements. CSS should not be large.

Make the UI bar thin and closer to the edge, and 75% down. Use shorter terms like 5H --% and 7D --% and M$ (5 hour first).

None of the labels should be longer than 4 characters including the : so that it is compact.

Make last updated appear only on hover using title for our whole little widiget, and make the widget draggable vertically but not horizontally on the viewport.

## Implementation details

Use proper JSDOC typing and runtime type checking where reasonable to make the ts language server happy (have no type complaints).

Full JSDOC strings for all functions.

Don't do inefficient searches for elements like going down every mutation node.

Use single xpath queries to find the chat box warning element, and make it slightly ambiguous such that if the number or context changes slightly we still find it, but not too ambiguous such that we find the wrong element.

## Scraped information

### Chat box warning

The chat box warning in question does not always appear visibly and can be removed by clicking X on it, but instead we will use a mutation observer on the whole page which merely checks for it's existence when nodes are added and sets it's display to none if it is found. This way, the user will not have to worry about it at all.

The chat box ui element we do not want is

```html
<div class="px-3 md:px-2"><div style="opacity: 1; height: auto;"><div class="w-full border-0.5 relative z-0 px-3.5 -mb-1 -mt-1 rounded-b-xl border-t-0 pb-2 pt-2.5 bg-bg-300 border-transparent"><div role="status" aria-live="polite" class="font-normal text-[0.65rem] sm:text-xs w-full flex gap-1.5 items-center justify-between"><span class="text-text-300 text-sm">You've used 75% of your weekly limit</span><span><button class="inline underline underline-offset-[3px] [&amp;:not(:is(:hover,:focus))]:decoration-[color-mix(in_srgb,currentColor,transparent_60%)] cursor-pointer text-sm">Get more usage</button><button class="inline-flex
  items-center
  justify-center
  relative
  shrink-0
  can-focus
  select-none
  disabled:pointer-events-none
  disabled:opacity-50
  disabled:shadow-none
  disabled:drop-shadow-none border-transparent
          transition
          font-base
          duration-300
          ease-[cubic-bezier(0.165,0.85,0.45,1)] h-6 w-6 rounded-md active:scale-95 ml-2 !bg-transparent Button_ghost__BUAoh" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path></svg></button></span></div></div></div></div>
```

We will find the element with it's text content using xpath and the closest div with the class `px-3 md:px-2` and set it's display to none.

### Fetch Example

Only use the likely to be required headers, and the endpoint itself.

For `Accept-Language` and `User-Agent`, use the same as the users retrieved from built-in js features.

```js
await fetch(endpoint, {
    "credentials": "include",
    "headers": {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
        "Accept": "*/*",
        "Accept-Language": "en-CA,en-US;q=0.9,en;q=0.8",
        "content-type": "application/json",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Priority": "u=4",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache"
    },
    "referrer": "https://claude.ai/settings/usage",
    "method": "GET",
    "mode": "cors"
});
```

### Usage Stats Endpoints

Using a mutation observer to wait until nothing has been added to the page for more than 500ms, we need to first find the organization of the user.

While the organization is not found, our widget has a pastel yellow tint.

The organization ID is read directly from the `lastActiveOrg` cookie set by claude.ai.

```js
const orgId = document.cookie.split('; ').find(c => c.startsWith('lastActiveOrg='))?.split('=')[1] ?? null;
```

#### Usage Stats

```js
const usageStatsEndpoint = `https://claude.ai/api/organizations/${orgId}/usage`;
```

##### Response

Example response:

```json
{
    "five_hour": {
        "utilization": 5.0, // percentage
        "resets_at": "2026-04-15T06:00:01.158327+00:00"
    },
    "seven_day": {
        "utilization": 92.0, // percentage
        "resets_at": "2026-04-20T22:00:00.158241+00:00"
    },
    "seven_day_oauth_apps": null,
    "seven_day_opus": null,
    "seven_day_sonnet": null,
    "seven_day_cowork": null,
    "iguana_necktie": null,
    "extra_usage": {
        "is_enabled": true,
        "monthly_limit": 1450, // cents (so this is $14.50)
        "used_credits": 0.0,
        "utilization": null
    }
}
```

#### Overage Spend Limit

This endpoint returns the organization's monthly overage spend cap, current usage, and whether the account has been disabled for exceeding the limit.

```js
const overageSpendLimitEndpoint = `https://claude.ai/api/organizations/${orgId}/overage_spend_limit`;
```

##### Response

Fields of interest: `is_enabled`, `monthly_credit_limit`, `currency`, `used_credits`, `disabled_until`.

Example response:

```json
{
    "organization_uuid": "...",
    "limit_type": "organization",
    "seat_tier": null,
    "account_uuid": null,
    "account_email": null,
    "account_name": null,
    "group_uuid": null,
    "group_name": null,
    "group_deleted": null,
    "org_service_name": null,
    "is_enabled": true,                          // whether the overage spend feature is turned on at all
    "monthly_credit_limit": 6000,               // cents (so this is $60.00)
    "currency": "CAD",
    "used_credits": 6230,                       // cents consumed this month; here slightly over limit
    "disabled_reason": "self_selected_spend_limit_reached", // null if not over limit
    "disabled_until": "2026-05-01T00:00:00Z",   // null if overage is enabled and cap not yet reached or if overages are not enabled; otherwise start of next billing month.
    "out_of_credits": false,
    "discount_percent": null,
    "discount_ends_at": null,
    "resolved_group_limit": null,
    "settings": null,
    "created_at": "2026-01-15T14:22:31.641203Z",
    "updated_at": "2026-03-17T09:42:18.877641Z"
}
```
