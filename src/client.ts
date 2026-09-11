import got, { ExtendOptions, Got } from 'got';
import { Cookie, CookieJar } from 'tough-cookie';

const cookieJar = new CookieJar();
type CookieResponse = Cookie[] | undefined;
let login: () => Promise<CookieResponse> = () => Promise.resolve(undefined);
let instance: Got = got.extend({
    cookieJar,
    retry: { limit: 2 },
    followRedirect: false,
    hooks: {
        // init: [
        //     (optionsInit, options) => {
        //         optionsInit.url = new URL(optionsInit.url?.toString() || '', options.prefixUrl);
        //     }
        // ],
        beforeRequest: [
            (options) => {
                console.log(options.url?.toString());
                if (!options.prefixUrl) {

                }
            },
        ],
        afterResponse: [
            async (response, retryWithMergedOptions) => {
                if (response.statusCode === 302 || response.statusCode === 301 || response.statusCode === 307 || response.statusCode === 303) {
                    const location = response.headers.location;
                    if (location && (location.startsWith('/TDAdmin/Login') || location.startsWith('/TDClient/Login'))) {
                        // check for infinite loop?
                        const cookies = await login();
                        if (!cookies) {
                            throw new Error('Failed to obtain session cookie');
                        }
                        console.log('Setting cookies:', cookies);
                        //cookieJar.setCookie(cookie, response.url);
                        cookies.forEach(cookie => setCookie(cookie));
                        // Debug: log what's in the jar
                console.log('Cookies in jar:', await cookieJar.getCookies(response.url));
                
                        return retryWithMergedOptions({});
                    }
                }

                return response;
            },
        ],
    },
});

function setCookie(cookieHeader: Cookie | undefined) {
    if (cookieHeader) {
        cookieJar.setCookieSync(cookieHeader, instance.defaults.options.prefixUrl.toString() || '');
    }
}

export default {
    setBaseUrl(baseUrl: string) {
        instance = instance.extend({
            prefixUrl: baseUrl,
        });
    },
    setCookie,
    setLogin(loginFn: () => Promise<CookieResponse>) {
        login = loginFn;
    },
    get client() {
        return instance;
    },
};