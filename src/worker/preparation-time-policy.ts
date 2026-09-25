export type PreparationTimePolicyInput = {
	basePrepMinutes: number;
	normalOrderMinutes: number;
	specialExtraMinutes: number;
	ordersAhead: number;
	specialOrdersAhead: number;
};

export type PreparationTimeEstimate = {
	leadMinutes: number;
	estimatedReadyAt: string;
};

const PREPARATION_BUFFER_MINUTES = 5;
const PREPARATION_ROUNDING_MINUTES = 5;

function requireNonNegativeInteger(value: number, name: string) {
	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative integer`);
	}
}

export function getPreparationTimeEstimate(
	input: PreparationTimePolicyInput,
	now: Date,
): PreparationTimeEstimate {
	requireNonNegativeInteger(input.basePrepMinutes, "basePrepMinutes");
	requireNonNegativeInteger(input.normalOrderMinutes, "normalOrderMinutes");
	requireNonNegativeInteger(input.specialExtraMinutes, "specialExtraMinutes");
	requireNonNegativeInteger(input.ordersAhead, "ordersAhead");
	requireNonNegativeInteger(input.specialOrdersAhead, "specialOrdersAhead");

	if (input.specialOrdersAhead > input.ordersAhead) {
		throw new RangeError("specialOrdersAhead must not exceed ordersAhead");
	}

	if (Number.isNaN(now.getTime())) {
		throw new RangeError("now must be a valid date");
	}

	const calculatedLeadMinutes =
		input.basePrepMinutes +
		input.ordersAhead * input.normalOrderMinutes +
		input.specialOrdersAhead * input.specialExtraMinutes;
	const leadMinutes = roundPreparationDurationMinutes(
		Math.max(input.basePrepMinutes, calculatedLeadMinutes),
	);
	const initialReadyAt = now.getTime() + leadMinutes * 60_000;
	const roundingMilliseconds = PREPARATION_ROUNDING_MINUTES * 60_000;

	return {
		leadMinutes,
		estimatedReadyAt: new Date(
			Math.ceil(initialReadyAt / roundingMilliseconds) * roundingMilliseconds,
		).toISOString(),
	};
}

export function roundPreparationDurationMinutes(estimatedDurationMinutes: number) {
	requireNonNegativeInteger(estimatedDurationMinutes, "estimatedDurationMinutes");
	return Math.ceil(
		(estimatedDurationMinutes + PREPARATION_BUFFER_MINUTES) /
			PREPARATION_ROUNDING_MINUTES,
	) * PREPARATION_ROUNDING_MINUTES;
}
