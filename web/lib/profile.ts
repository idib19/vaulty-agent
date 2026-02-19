export interface UserProfile {
  firstName: string;
  lastName: string;
  fullName?: string;
  email: string;
  phone?: string;

  address?: {
    street?: string;
    street2?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
  };

  gender?: string;
  raceEthnicity?: string;
  veteranStatus?: string;

  linkedIn?: string;
  website?: string;

  updatedAt?: string;
}

export function getFullName(profile: UserProfile): string {
  if (profile.fullName) return profile.fullName;
  return `${profile.firstName} ${profile.lastName}`.trim();
}

export function formatAddress(profile: UserProfile): string {
  if (!profile.address) return "";
  const { street, street2, city, state, zipCode, country } = profile.address;
  return [street, street2, city, state, zipCode, country].filter(Boolean).join(", ");
}

/**
 * Flatten profile into key-value pairs the LLM can use when filling forms.
 */
export function profileToContext(profile: UserProfile): Record<string, string> {
  const ctx: Record<string, string> = {};

  if (profile.firstName) {
    ctx["first name"] = profile.firstName;
    ctx["firstName"] = profile.firstName;
  }
  if (profile.lastName) {
    ctx["last name"] = profile.lastName;
    ctx["lastName"] = profile.lastName;
  }
  ctx["full name"] = getFullName(profile);
  if (profile.email) ctx["email"] = profile.email;
  if (profile.phone) ctx["phone"] = profile.phone;

  if (profile.address) {
    const a = profile.address;
    if (a.street) ctx["street address"] = a.street;
    if (a.street2) ctx["address line 2"] = a.street2;
    if (a.city) ctx["city"] = a.city;
    if (a.state) ctx["state"] = a.state;
    if (a.zipCode) ctx["zip code"] = a.zipCode;
    if (a.country) ctx["country"] = a.country;
    ctx["full address"] = formatAddress(profile);
    const locParts = [a.city, a.state, a.country].filter(Boolean);
    if (locParts.length) ctx["location"] = locParts.join(", ");
  }

  if (profile.gender) ctx["gender"] = profile.gender;
  if (profile.raceEthnicity) ctx["race/ethnicity"] = profile.raceEthnicity;
  if (profile.veteranStatus) ctx["veteran status"] = profile.veteranStatus;

  if (profile.linkedIn) {
    ctx["linkedin url"] = profile.linkedIn;
    ctx["linkedIn"] = profile.linkedIn;
  }
  if (profile.website) {
    ctx["website"] = profile.website;
    ctx["portfolio"] = profile.website;
  }

  return ctx;
}
