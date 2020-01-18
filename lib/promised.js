const Promised = async function Promised() {
    return new Promise(async (resolve, reject) => {
        const callback = arguments[arguments.length - 1];
        delete arguments[arguments.length - 1];
        let args = [];
        for (const arg of arguments) {
            args[args.length] = arg;
        }
        resolve(callback.apply(this, args));
    })
}
module.exports = Promised;