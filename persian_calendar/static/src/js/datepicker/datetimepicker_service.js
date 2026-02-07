/** @odoo-module **/

import { markRaw, reactive } from "@odoo/owl";
import { areDatesEqual, formatDate, formatDateTime, parseDate, parseDateTime } from "@web/core/l10n/dates";
import { makePopover } from "@web/core/popover/popover_hook";
import { registry } from "@web/core/registry";
import { ensureArray, zip, zipWith } from "@web/core/utils/arrays";
import { deepCopy, shallowEqual } from "@web/core/utils/objects";
import { DateTimePicker } from "@web/core/datetime/datetime_picker";
import { DateTimePickerPopover } from "@web/core/datetime/datetime_picker_popover";

/** @type {typeof shallowEqual} */
const arePropsEqual = (obj1, obj2) =>
    shallowEqual(obj1, obj2, (a, b) => areDatesEqual(a, b) || shallowEqual(a, b));

const FOCUS_CLASSNAME = "text-primary";

const formatters = {
    date: formatDate,
    datetime: formatDateTime,
};

const listenedElements = new WeakSet();

const parsers = {
    date: parseDate,
    datetime: parseDateTime,
};

function leftPad(number, targetLength) {
    var output = number + '';
    while (output.length < targetLength) {
        output = '0' + output;
    }
    return output;
}

export const datetimePickerService = {
    dependencies: ["popover"],
    start(env, { popover: popoverService }) {
        return {
            /**
             * @param {DateTimePickerHookParams} hookParams
             */
            create: (hookParams, getInputs = () => [hookParams.target, null]) => {
                const createPopover =
                    hookParams.createPopover ??
                    ((...args) => makePopover(popoverService.add, ...args));
                const ensureVisibility = hookParams.ensureVisibility ?? (() => env.isSmall);
                const popover = createPopover(DateTimePickerPopover, {
                    onClose: () => {
                        if (!allowOnClose) {
                            return;
                        }
                        updateValueFromInputs();
                        apply();
                        setFocusClass(null);
                        if (restoreTargetMargin) {
                            restoreTargetMargin();
                            restoreTargetMargin = null;
                        }
                    },
                });

                const apply = () => {
                    const valueCopy = deepCopy(pickerProps.value);
                    if (areDatesEqual(lastAppliedValue, valueCopy)) {
                        return;
                    }

                    inputsChanged = ensureArray(pickerProps.value).map(() => false);

                    hookParams.onApply?.(pickerProps.value);
                    lastAppliedValue = valueCopy;
                };

                const computeBasePickerProps = () => {
                    const nextInitialProps = markValuesRaw(hookParams.pickerProps);
                    const propsCopy = deepCopy(nextInitialProps);

                    if (lastInitialProps && arePropsEqual(lastInitialProps, propsCopy)) {
                        return;
                    }

                    lastInitialProps = propsCopy;
                    lastAppliedValue = propsCopy.value;
                    inputsChanged = ensureArray(lastInitialProps.value).map(() => false);

                    for (const [key, value] of Object.entries(nextInitialProps)) {
                        if (pickerProps[key] !== value && !areDatesEqual(pickerProps[key], value)) {
                            pickerProps[key] = value;
                        }
                    }
                };

                const focusActiveInput = () => {
                    const inputEl = getInput(pickerProps.focusedDateIndex);
                    if (!inputEl) {
                        shouldFocus = true;
                        return;
                    }

                    const { activeElement } = inputEl.ownerDocument;
                    if (activeElement !== inputEl) {
                        inputEl.focus();
                    }

                    setInputFocus(inputEl);
                };

                /**
                 * Helper to safely resolve DOM Element from Ref, Selector or Element
                 */
                const resolveElement = (el) => {
                    if (!el) return null;
                    if (el.nodeType) return el; // Already a DOM Node
                    if (typeof el === 'object' && 'el' in el) return el.el; // OWL Ref
                    if (typeof el === 'string') {
                        try { return document.querySelector(el); } catch { return null; }
                    }
                    return el; // Return as is if we can't determine
                };

                /**
                 * @param {number} valueIndex
                 * @returns {HTMLInputElement | null}
                 */
                const getInput = (valueIndex) => {
                    const el = resolveElement(getInputs()[valueIndex]);
                    // FIX: Relaxed check (removed document.body.contains) to prevent silent failures
                    if (el) {
                        return el;
                    }
                    return null;
                };

                const getPopoverTarget = () => {
                    const target = resolveElement(hookParams.target);
                    if (target) {
                        return target;
                    }
                    if (pickerProps.range) {
                        let parentElement = getInput(0)?.parentElement;
                        const inputEls = [getInput(0), getInput(1)].filter(Boolean);
                        // Loop up to find common parent
                        while (
                            parentElement &&
                            inputEls.length > 0 &&
                            !inputEls.every((inputEl) => parentElement.contains(inputEl))
                        ) {
                            parentElement = parentElement.parentElement;
                        }
                        return parentElement || getInput(0);
                    } else {
                        return getInput(0);
                    }
                };

                const markValuesRaw = (obj) => {
                    const copy = {};
                    for (const [key, value] of Object.entries(obj)) {
                        if (value && typeof value === "object") {
                            copy[key] = markRaw(value);
                        } else {
                            copy[key] = value;
                        }
                    }
                    return copy;
                };

                const onInputChange = (ev) => {
                    updateValueFromInputs();
                    inputsChanged[ev.target === getInput(1) ? 1 : 0] = true;
                    if (!popover.isOpen || inputsChanged.every(Boolean)) {
                        saveAndClose();
                    }
                };

                const onInputClick = ({ target }) => {
                    openPicker(target === getInput(1) ? 1 : 0);
                };

                const onInputFocus = ({ target }) => {
                    pickerProps.focusedDateIndex = target === getInput(1) ? 1 : 0;
                    setInputFocus(target);
                };

                const onInputKeydown = (ev) => {
                    if (ev.key == "Enter" && ev.ctrlKey) {
                        ev.preventDefault();
                        updateValueFromInputs();
                        return openPicker(ev.target === getInput(1) ? 1 : 0);
                    }
                    switch (ev.key) {
                        case "Enter":
                        case "Escape": {
                            return saveAndClose();
                        }
                        case "Tab": {
                            if (
                                !getInput(0) ||
                                !getInput(1) ||
                                ev.target !== getInput(ev.shiftKey ? 1 : 0)
                            ) {
                                return saveAndClose();
                            }
                        }
                    }
                };

                const openPicker = (inputIndex) => {
                    pickerProps.focusedDateIndex = inputIndex;

                    if (!popover.isOpen) {
                        const popoverTarget = getPopoverTarget();
                        
                        // FIX: Ensure target exists before trying to open
                        if (!popoverTarget) {
                            console.warn("Persian Calendar: Popover target not found.");
                            return;
                        }

                        if (ensureVisibility()) {
                            const { marginBottom } = popoverTarget.style;
                            popoverTarget.style.marginBottom = `100vh`;
                            popoverTarget.scrollIntoView(true);
                            restoreTargetMargin = async () => {
                                popoverTarget.style.marginBottom = marginBottom;
                            };
                        }
                        popover.open(popoverTarget, { pickerProps });
                    }

                    focusActiveInput();
                };

                const safeConvert = (operation, value) => {
                    const { type } = pickerProps;
                    const convertFn = (operation === "format" ? formatters : parsers)[type];
                    const options = { tz: pickerProps.tz, format: hookParams.format };
                    if (operation === "format") {
                        options.showSeconds = hookParams.showSeconds ?? true;
                        options.condensed = hookParams.condensed || false;
                    }
                    try {
                        return [convertFn(value, options), null];
                    } catch (error) {
                        if (error?.name === "ConversionError") {
                            return [null, error];
                        } else {
                            throw error;
                        }
                    }
                };

                const saveAndClose = () => {
                    if (popover.isOpen) {
                        popover.close();
                    } else {
                        apply();
                    }
                };

                const setFocusClass = (input) => {
                    [getInput(0), getInput(1)].forEach((el) => {
                        if (el) {
                            el.classList.toggle(FOCUS_CLASSNAME, popover.isOpen && el === input);
                        }
                    });
                };

                const setInputFocus = (inputEl) => {
                    if (inputEl) {
                        inputEl.selectionStart = 0;
                        inputEl.selectionEnd = inputEl.value.length;
                        setFocusClass(inputEl);
                        shouldFocus = false;
                    }
                };

                const updateInput = (el, value) => {
                    if (!el) {
                        return;
                    }
                    const [formattedValue] = safeConvert("format", value);

                    if(luxon.DateTime.now().locale == 'fa-IR'){
                        let jressult_str = ""
                        if(formattedValue && formattedValue.split(' ')[1]){
                            if(formattedValue.split(' ')[0].split('/')[2]){
                                const gressult = formattedValue.split(' ')[0].split('/');
                                const jressult = farvardin.gregorianToSolar(parseInt(gressult[0]) , parseInt(gressult[1]) , parseInt(gressult[2]));
                                jressult_str =  `${jressult[0]}/${leftPad(jressult[1], 2)}/${leftPad(jressult[2], 2)} ${formattedValue.split(' ')[1]}`;
                            }else if(formattedValue.split(' ')[0].split('-')[2]){
                                const gressult = formattedValue.split(' ')[0].split('-');
                                const jressult = farvardin.gregorianToSolar(parseInt(gressult[0]) , parseInt(gressult[1]) , parseInt(gressult[2]));
                                jressult_str =  `${jressult[0]}-${leftPad(jressult[1], 2)}-${leftPad(jressult[2], 2)} ${formattedValue.split(' ')[1]}`;
                            }
                        }
                        else if (formattedValue){
                            if(formattedValue.split('/')[2]){
                                const gressult = formattedValue.split('/');
                                const jressult = farvardin.gregorianToSolar(parseInt(gressult[0]) , parseInt(gressult[1]) , parseInt(gressult[2]));
                                jressult_str =  `${jressult[0]}/${leftPad(jressult[1], 2)}/${leftPad(jressult[2], 2)}`;
                            }else if(formattedValue.split('-')[2]){
                                const gressult = formattedValue.split('-');
                                const jressult = farvardin.gregorianToSolar(parseInt(gressult[0]) , parseInt(gressult[1]) , parseInt(gressult[2]));
                                jressult_str =  `${jressult[0]}-${leftPad(jressult[1], 2)}-${leftPad(jressult[2], 2)}`;
                            }
                        }
                        el.value = jressult_str || "";
                    }else{
                        el.value = formattedValue || "";
                    }
                };

                const updateValue = (value, unit, source) => {
                    const previousValue = pickerProps.value;
                    pickerProps.value = value;

                    if (source === "input" && areDatesEqual(previousValue, pickerProps.value)) {
                        return;
                    }

                    if (unit !== "time") {
                        if (pickerProps.range && source === "picker") {
                            if (
                                pickerProps.focusedDateIndex === 0 ||
                                (value[0] && value[1] && value[1] < value[0])
                            ) {
                                const { year, month, day } = value[pickerProps.focusedDateIndex];
                                for (let i = 0; i < value.length; i++) {
                                    value[i] = value[i] && value[i].set({ year, month, day });
                                }
                                pickerProps.focusedDateIndex = 1;
                            } else {
                                pickerProps.focusedDateIndex =
                                    pickerProps.focusedDateIndex === 1 ? 0 : 1;
                            }
                        }
                    }

                    hookParams.onChange?.(value);
                };

                const updateValueFromInputs = () => {
                    const values = zipWith(
                        [getInput(0), getInput(1)],
                        ensureArray(pickerProps.value),
                        (el, currentValue) => {
                            if (!el) {
                                return currentValue;
                            }
                            let jressult_str = "";
                            if(el.value.split(' ')[1]){
                                if(el.value.split(' ')[0].split('/')[2]){
                                    const gressult = el.value.split(' ')[0].split('/');
                                    const jressult = farvardin.solarToGregorian(parseInt(gressult[0]) , parseInt(gressult[1]) , parseInt(gressult[2]));
                                    jressult_str =  `${jressult[0]}/${jressult[1]}/${jressult[2]} ${el.value.split(' ')[1]}`;
                                }else if(el.value.split(' ')[0].split('-')[2]){
                                    const gressult = el.value.split(' ')[0].split('-');
                                    const jressult = farvardin.solarToGregorian(parseInt(gressult[0]) , parseInt(gressult[1]) , parseInt(gressult[2]));
                                    jressult_str =  `${jressult[0]}-${leftPad(jressult[1], 2)}-${leftPad(jressult[2], 2)} ${el.value.split(' ')[1]}`;
                                }
                            }
                            else{
                                if(el.value.split('/')[2]){
                                    const gressult = el.value.split('/');
                                    const jressult = farvardin.solarToGregorian(parseInt(gressult[0]) , parseInt(gressult[1]) , parseInt(gressult[2]));
                                    jressult_str =  `${jressult[0]}/${jressult[1]}/${jressult[2]}`;
                                }else if(el.value.split('-')[2]){
                                    const gressult = el.value.split('-');
                                    const jressult = farvardin.solarToGregorian(parseInt(gressult[0]) , parseInt(gressult[1]) , parseInt(gressult[2]));
                                    jressult_str =  `${jressult[0]}-${leftPad(jressult[1], 2)}-${leftPad(jressult[2], 2)}`;
                                }
                            }
                            const [parsedValue, error] = safeConvert("parse", jressult_str);
                           if (error) {
                                updateInput(el, currentValue);
                                return currentValue;
                            } else {
                                return parsedValue;
                            }
                        }
                    );
                    updateValue(values.length === 2 ? values : values[0], "date", "input");
                };

                const rawPickerProps = {
                    ...DateTimePicker.defaultProps,
                    onSelect: (value, unit) => {
                        value &&= markRaw(value);
                        updateValue(value, unit, "picker");
                        if (!pickerProps.range && pickerProps.type === "date") {
                            saveAndClose();
                        }
                    },
                    ...markValuesRaw(hookParams.pickerProps),
                };
                const pickerProps = reactive(rawPickerProps, () => {
                    const currentIsRange = pickerProps.range;
                    if (popover.isOpen && lastIsRange !== currentIsRange) {
                        allowOnClose = false;
                        popover.open(getPopoverTarget(), { pickerProps });
                        allowOnClose = true;
                    }
                    lastIsRange = currentIsRange;

                    [getInput(0), getInput(1)].forEach((el, idx) => {
                        const val = ensureArray(pickerProps.value)[idx];
                        if (el) updateInput(el, val);
                    });

                    shouldFocus = true;
                });

                let allowOnClose = true;
                let inputsChanged = [];
                let lastInitialProps = null;
                let lastAppliedValue = null;
                let lastIsRange = pickerProps.range;
                let restoreTargetMargin = null;
                let shouldFocus = false;

                const onIconClick = () => openPicker(0);

                const cleanup = () => {
                     // FIX: Use 0, 1 index and resolveElement instead of calling getInput which has checks
                     [0, 1].forEach(idx => {
                        const rawEl = getInputs()[idx];
                        const el = resolveElement(rawEl);
                        if (el && listenedElements.has(el)) {
                            listenedElements.delete(el);
                            el.removeEventListener("change", onInputChange);
                            el.removeEventListener("click", onInputClick);
                            el.removeEventListener("focus", onInputFocus);
                            el.removeEventListener("keydown", onInputKeydown);
                        }
                    });
                    
                    const input0 = resolveElement(getInputs()[0]);
                    if (input0?.parentElement) {
                        const icon = input0.parentElement.querySelector(".o_input_group_date_icon");
                        if (icon) {
                             icon.classList.remove("cursor-pointer");
                             icon.removeEventListener("click", onIconClick);
                        }
                    }
                };

                return {
                    state: pickerProps,
                    open: openPicker,
                    computeBasePickerProps,
                    focusIfNeeded() {
                        if (popover.isOpen && shouldFocus) {
                            focusActiveInput();
                        }
                    },
                    enable() {
                        let editableInputs = 0;
                        // Resolve inputs safely
                        const inputEls = [resolveElement(getInputs()[0]), resolveElement(getInputs()[1])];
                        const values = ensureArray(pickerProps.value);
                        
                        inputEls.forEach((el, i) => {
                            if (!el) return;
                            updateInput(el, values[i]);
                            if (!el.disabled && !el.readOnly && !listenedElements.has(el)) {
                                listenedElements.add(el);
                                el.addEventListener("change", onInputChange);
                                el.addEventListener("click", onInputClick);
                                el.addEventListener("focus", onInputFocus);
                                el.addEventListener("keydown", onInputKeydown);
                                editableInputs++;
                            }
                        });

                        const input0 = inputEls[0];
                        if (input0?.parentElement) {
                            const icon = input0.parentElement.querySelector(".o_input_group_date_icon");
                            if (icon) {
                                icon.classList.add("cursor-pointer");
                                // Fix: Remove before adding to prevent duplicates
                                icon.removeEventListener("click", onIconClick);
                                icon.addEventListener("click", onIconClick);
                            }
                        }
                        if (!editableInputs && popover.isOpen) {
                            saveAndClose();
                        }
                        return cleanup;
                    },
                    disable: cleanup,
                    get isOpen() {
                        return popover.isOpen;
                    },
                };
            },
        };
    },
};

registry.category("services").remove("datetime_picker");
registry.category("services").add("datetime_picker", datetimePickerService);