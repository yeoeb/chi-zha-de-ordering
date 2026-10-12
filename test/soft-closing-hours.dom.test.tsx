import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { BusinessHoursPill } from "../src/react-app/CustomerComponents";
afterEach(cleanup);
it.each(['23:15',null])('labels the approved soft closing policy instead of a hard last-order cutoff (%s)',async lastOrderAt=>{
 render(<BusinessHoursPill todayIsOpen todayOpenAt="17:30" todayCloseAt="23:15" lastOrderAt={lastOrderAt}/>);
 await userEvent.click(screen.getByRole('button'));
 expect(screen.getByText('最早收店')).toBeTruthy();
 expect(screen.getByText('23:15 後依訂單狀況延後收店，請依目前接單狀態下單。')).toBeTruthy();
});
it('retains the Admin configured earlier last-order contract',async()=>{
 render(<BusinessHoursPill todayIsOpen todayOpenAt="17:30" todayCloseAt="23:15" lastOrderAt="23:00"/>);
 await userEvent.click(screen.getByRole('button'));
 expect(screen.getByText('最後接單')).toBeTruthy();expect(screen.queryByText('最早收店')).toBeNull();
});
