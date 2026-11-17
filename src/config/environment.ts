export type Environment = Record<string, string | undefined>;

export function validateEnvironment(environment: Environment): Environment {
  const timezone = environment.BUSINESS_TIMEZONE ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(
      `Invalid BUSINESS_TIMEZONE configuration: '${timezone}' is not a valid IANA timezone identifier`,
    );
  }
  return { ...environment, BUSINESS_TIMEZONE: timezone };
}
