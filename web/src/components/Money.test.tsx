import { render } from "@testing-library/react";

import { Money } from "./Money";

describe("Money", () => {
  it("renders UGX integers with tabular numerals", () => {
    const { container } = render(<Money amount={70000} />);

    expect(container.firstChild).toMatchInlineSnapshot(`
      <span
        class="money-nums inline-block text-[15px] font-medium leading-5 text-right text-ink-900"
      >
        UGX 
        70,000
      </span>
    `);
  });

  it("uses the hero scale and positive green", () => {
    const { container } = render(<Money amount={70000} size="hero" tone="positive" />);

    expect(container.firstChild).toMatchInlineSnapshot(`
      <span
        class="money-nums inline-block text-[40px] font-bold leading-none text-gezi-green-700"
      >
        UGX 
        70,000
      </span>
    `);
  });

  it("uses a true minus sign and danger color for negative amounts", () => {
    const { container } = render(<Money amount={-70000} size="card" tone="positive" />);

    expect(container.firstChild).toMatchInlineSnapshot(`
      <span
        class="money-nums inline-block text-2xl font-semibold leading-tight text-danger-600"
      >
        −
        UGX 
        70,000
      </span>
    `);
  });
});
