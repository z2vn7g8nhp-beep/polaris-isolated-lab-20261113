import test from "node:test";
import assert from "node:assert/strict";
import { captureDrafts, clearDrafts, beginBusy } from "../docs/dom-state.mjs";

function editor() {
  const form = { id: "memo", dataset: {}, getAttribute: () => "memo",
    querySelectorAll: () => controls.filter((c) => Object.hasOwn(c.dataset, "dirty")) };
  const controls = [
    { id: "review", name: "review", type: "textarea", value: "提交的短评", dataset: { dirty: "true" }, form },
    { id: "tags", name: "tags", type: "text", value: "IMAX", dataset: { dirty: "true" }, form },
  ];
  return { form, controls };
}
test("a completed save cleans submitted values while retaining edits typed during the request", () => {
  const { form, controls } = editor(), submitted = captureDrafts(form);
  controls[0].value = "请求期间继续写的短评";
  clearDrafts(form, submitted);
  assert.equal(controls[0].dataset.dirty, "true");
  assert.equal(controls[1].dataset.dirty, undefined);
  assert.equal(captureDrafts(form)[0].value, "请求期间继续写的短评");
});
test("a form in flight rejects another submit even when a different submit control is used", () => {
  const { form } = editor(), first = { dataset: {}, form, disabled: false }, second = { dataset: {}, form, disabled: false };
  const finish = beginBusy(first);
  assert.equal(first.disabled, true); assert.equal(beginBusy(first), null); assert.equal(beginBusy(second), null);
  finish(); assert.equal(first.disabled, false);
  const next = beginBusy(second); assert.equal(typeof next, "function"); next();
});
