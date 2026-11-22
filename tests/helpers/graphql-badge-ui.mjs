import assert from "node:assert/strict";

export async function assertGraphQLBadge(button) {
  const badge = button.locator(":scope > .method.graphql-badge");
  assert.equal(await badge.innerText(), "GQL");
  assert.equal(await badge.getAttribute("title"), "GraphQL");
  assert.equal(await badge.getAttribute("aria-hidden"), "true");
  assert.match(await button.getAttribute("title"), /^GraphQL /);
  const named = button.and(
    button.page().getByRole("button", { name: /^GraphQL / }),
  );
  assert.equal(await named.count(), 1, "full accessible GraphQL request name");
  const layout = await badge.evaluate((el) => {
    const name = el.nextElementSibling.getBoundingClientRect();
    const button = el.parentElement.getBoundingClientRect();
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const ink = range.getBoundingClientRect();
    return {
      viewport: el.ownerDocument.defaultView.innerWidth,
      badge: [ink.left, ink.right, ink.width],
      name: [name.left, name.right, name.width],
      button: [button.left, button.right],
    };
  });
  const msg = JSON.stringify(layout);
  assert(layout.badge[2] > 0 && layout.name[2] > 0, msg);
  assert(layout.badge[0] >= layout.button[0], msg);
  assert(layout.badge[1] <= layout.button[1], msg);
  assert(layout.badge[1] <= layout.name[0], msg);
  return layout;
}
