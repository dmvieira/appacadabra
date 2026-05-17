import * as Contacts from 'expo-contacts';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const contactsCapability: CapabilityModule = {
    id: 'contacts',
    displayName: 'Contacts',
    minVersion: '1.0.0',
    description: "`search` finds contacts by name, phone, email, or company; `add` opens the native add-contact form pre-filled; `update` opens the native edit form for an existing contact.",
    androidPermissions: [
        'android.permission.READ_CONTACTS',
        'android.permission.WRITE_CONTACTS',
    ],

    docs: `📇 CONTACTS (AppacadabraContacts): prefer search/update
- \`search(query, callback)\` - Search contacts by name, phone, email, or company
    - **data** is an Array: \`[{id, name, firstName, lastName, phoneNumbers: [{number, label}], emails: [{email, label}], company, jobTitle, ...}]\`
- \`update(contactObj, callback)\` - Opens native edit form with pre-filled data
    - **Return**: Contact ID (string) or "Contact form presented"
- \`add(contactObj, callback)\` - Opens native add form with pre-filled data
    - **Return**: "Contact form presented"

**contactObj structure** (Native Expo Contacts format):
\`\`\`javascript
{
  id: "string",           // REQUIRED for update only
  name: "string",         // Full name
  firstName: "string",    // First name
  lastName: "string",     // Last name
  company: "string",      // Company name
  jobTitle: "string",     // Job title
  department: "string",   // Department
  nickname: "string",     // Nickname
  note: "string",         // Notes
  phoneNumbers: [         // Array of phones
    { number: "string", label: "mobile|home|work" }
  ],
  emails: [               // Array of emails
    { email: "string", label: "work|home" }
  ],
  addresses: [            // Array of addresses
    {
      street: "string",
      city: "string",
      region: "string", // State/Region
      postalCode: "string", // Zip
      country: "string",
      label: "home|work"
    }
  ],
  birthday: { year: number, month: number, day: number }, // Object
  urlAddresses: [         // Websites
    { url: "string", label: "homepage" }
  ]
}
\`\`\``,

    validationMock: `    window.AppacadabraContacts = apiProxy;`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  function validateContactObj(contact, isUpdate) {
    if (!contact || typeof contact !== 'object') {
      return { valid: false, error: 'Contact must be an object' };
    }
    if (isUpdate && !contact.id) {
      return { valid: false, error: 'Contact ID is required for update' };
    }
    var sanitized = {};
    var stringFields = ['id', 'name', 'firstName', 'lastName', 'middleName', 'company', 'jobTitle', 'department', 'nickname', 'note'];
    stringFields.forEach(function(field) {
      if (contact[field] !== undefined && contact[field] !== null) {
        sanitized[field] = String(contact[field]);
      }
    });

    var arrayFields = ['phoneNumbers', 'emails', 'addresses', 'urlAddresses'];
    arrayFields.forEach(function(field) {
      if (Array.isArray(contact[field])) {
        sanitized[field] = contact[field];
      }
    });

    if (contact.birthday && typeof contact.birthday === 'object') {
        sanitized.birthday = {
          year: Number(contact.birthday.year),
          month: Number(contact.birthday.month),
          day: Number(contact.birthday.day)
        };
    }
    if (contact.address) {
      if (typeof contact.address === 'string') {
        sanitized.address = contact.address;
      } else if (typeof contact.address === 'object') {
        sanitized.address = {
          street: String(contact.address.street || ''),
          city: String(contact.address.city || ''),
          region: String(contact.address.region || contact.address.state || ''),
          postalCode: String(contact.address.postalCode || contact.address.zipCode || ''),
          country: String(contact.address.country || ''),
          label: String(contact.address.label || 'home')
        };
      }
    }
    return { valid: true, sanitized: sanitized };
  }

  window.AppacadabraContacts = {
    search: function(query, callbackName) {
        console.log('[AppacadabraContacts.search] query:', query, 'callback:', callbackName);
        sendMessage('CONTACTS_SEARCH', { query }, callbackName);
    },
    add: function(contact, callbackName) {
        console.log('[AppacadabraContacts.add] name:', contact && contact.name, 'callback:', callbackName);
        var validation = validateContactObj(contact, false);
        if (!validation.valid) {
          console.error('[AppacadabraContacts.add] Validation error:', validation.error);
          if (callbackName && typeof window[callbackName] === 'function') {
            window[callbackName](false, validation.error);
          }
          return;
        }
        sendMessage('CONTACTS_ADD', { contact: validation.sanitized }, callbackName);
    },
    update: function(contact, callbackName) {
        console.log('[AppacadabraContacts.update] id:', contact && contact.id, 'callback:', callbackName);
        var validation = validateContactObj(contact, true);
        if (!validation.valid) {
          console.error('[AppacadabraContacts.update] Validation error:', validation.error);
          if (callbackName && typeof window[callbackName] === 'function') {
            window[callbackName](false, validation.error);
          }
          return;
        }
        sendMessage('CONTACTS_UPDATE', { contact: validation.sanitized }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'CONTACTS_SEARCH': {
                console.log(`[Bridge] Contacts search: ${data.query}`);
                try {
                    const searchPerm = await Contacts.requestPermissionsAsync();
                    if (searchPerm.status === 'granted') {
                        const { data: allContacts } = await Contacts.getContactsAsync({
                            fields: [
                                Contacts.Fields.Name,
                                Contacts.Fields.FirstName,
                                Contacts.Fields.LastName,
                                Contacts.Fields.PhoneNumbers,
                                Contacts.Fields.Emails,
                                Contacts.Fields.Company,
                                Contacts.Fields.JobTitle,
                                Contacts.Fields.Department,
                                Contacts.Fields.Note,
                                Contacts.Fields.UrlAddresses,
                                Contacts.Fields.Birthday,
                                Contacts.Fields.Addresses,
                                Contacts.Fields.Nickname,
                            ],
                        });
                        const query = (data.query || '').toLowerCase();

                        const filtered = allContacts.filter(c => {
                            if (!query) return true;
                            return (
                                c.name?.toLowerCase().includes(query) ||
                                c.firstName?.toLowerCase().includes(query) ||
                                c.lastName?.toLowerCase().includes(query) ||
                                c.phoneNumbers?.some(p => p.number?.includes(query)) ||
                                c.emails?.some(e => e.email?.toLowerCase().includes(query)) ||
                                c.company?.toLowerCase().includes(query)
                            );
                        });

                        console.log(`[Bridge] Found ${filtered.length} contacts`);
                        return { success: true, result: filtered.slice(0, 50) };
                    } else {
                        return { success: false, result: 'Contacts permission denied' };
                    }
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'CONTACTS_ADD': {
                console.log('[Bridge] Contacts add request');
                try {
                    const addPerm = await Contacts.requestPermissionsAsync();
                    if (addPerm.status === 'granted') {
                        const contact = data.contact || {};

                        const newContact: Partial<Contacts.Contact> = {
                            contactType: Contacts.ContactTypes.Person,
                            firstName: String(contact.firstName || ''),
                            lastName: String(contact.lastName || ''),
                            middleName: String(contact.middleName || ''),
                            name: String(contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || ''),
                            company: String(contact.company || ''),
                            jobTitle: String(contact.jobTitle || ''),
                            department: String(contact.department || ''),
                            nickname: String(contact.nickname || ''),
                            note: String(contact.note || ''),
                        };

                        if (Array.isArray(contact.phoneNumbers)) newContact.phoneNumbers = contact.phoneNumbers;
                        if (Array.isArray(contact.emails)) newContact.emails = contact.emails;
                        if (Array.isArray(contact.addresses)) newContact.addresses = contact.addresses;
                        if (Array.isArray(contact.urlAddresses)) newContact.urlAddresses = contact.urlAddresses;

                        if (contact.birthday) {
                            if (typeof contact.birthday === 'object') {
                                newContact.birthday = {
                                    year: Number(contact.birthday.year),
                                    month: Number(contact.birthday.month),
                                    day: Number(contact.birthday.day)
                                };
                            }
                        }

                        await Contacts.presentFormAsync(null, newContact as Contacts.Contact, { isNew: true });
                        return { success: true, result: 'Contact form presented' };
                    } else {
                        return { success: false, result: 'Contacts permission denied' };
                    }
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'CONTACTS_UPDATE': {
                console.log(`[Bridge] Contacts update request: ${data.contact?.id}`);
                try {
                    const updatePerm = await Contacts.requestPermissionsAsync();
                    if (updatePerm.status === 'granted') {
                        const contactData = data.contact || {};

                        if (!contactData.id) {
                            throw new Error('Contact ID is required for update');
                        }

                        const updatePayload: Record<string, any> = {
                            id: String(contactData.id)
                        };

                        const stringFields = ['firstName', 'lastName', 'middleName', 'company', 'jobTitle', 'department', 'nickname', 'note'];
                        stringFields.forEach(field => {
                            if (contactData[field] !== undefined) updatePayload[field] = String(contactData[field]);
                        });

                        if (Array.isArray(contactData.phoneNumbers)) updatePayload.phoneNumbers = contactData.phoneNumbers;
                        if (Array.isArray(contactData.emails)) updatePayload.emails = contactData.emails;
                        if (Array.isArray(contactData.addresses)) updatePayload.addresses = contactData.addresses;
                        if (Array.isArray(contactData.urlAddresses)) updatePayload.urlAddresses = contactData.urlAddresses;

                        if (contactData.birthday && typeof contactData.birthday === 'object') {
                            updatePayload.birthday = contactData.birthday;
                        }

                        try {
                            const resultId = await Contacts.updateContactAsync(updatePayload as any);
                            return { success: true, result: resultId };
                        } catch (updateError: any) {
                            const clipboardParts: string[] = [];

                            const fullName = [updatePayload.firstName, updatePayload.lastName].filter(Boolean).join(' ');
                            if (fullName) clipboardParts.push(`Nome: ${fullName}`);

                            if (updatePayload.phoneNumbers?.length) {
                                updatePayload.phoneNumbers.forEach((p: any) => clipboardParts.push(`Tel: ${p.number}`));
                            }
                            if (updatePayload.emails?.length) {
                                updatePayload.emails.forEach((e: any) => clipboardParts.push(`Email: ${e.email}`));
                            }
                            if (updatePayload.addresses?.length) {
                                updatePayload.addresses.forEach((a: any) => {
                                    const addrStr = [a.street, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', ');
                                    clipboardParts.push(`Endereço: ${addrStr}`);
                                });
                            }

                            if (updatePayload.company) clipboardParts.push(`Empresa: ${updatePayload.company}`);
                            if (updatePayload.jobTitle) clipboardParts.push(`Cargo: ${updatePayload.jobTitle}`);

                            const clipboardText = clipboardParts.join('\n');
                            const { Clipboard, Alert } = require('react-native');
                            if (clipboardText) Clipboard.setString(clipboardText);

                            await new Promise<void>((resolve) => {
                                Alert.alert('Dados copiados', 'As informações foram copiadas. Cole no editor.', [{ text: 'OK', onPress: () => resolve() }]);
                            });

                            await Contacts.presentFormAsync(String(contactData.id), null, { allowsEditing: true });
                            return { success: true, result: contactData.id };
                        }
                    } else {
                        return { success: false, result: 'Contacts permission denied' };
                    }
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            default:
                return null;
        }
    },
};
