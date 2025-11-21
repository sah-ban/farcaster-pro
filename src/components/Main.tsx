import { useState, useEffect, useRef, useCallback } from "react";
import {
  useAccount,
  useReadContract,
  useSendCalls,
  useConnect,
  useChainId,
  useSwitchChain,
  useBalance,
} from "wagmi";
import { base } from "viem/chains";
import { config } from "~/components/providers/WagmiProvider";
import sdk, { type Context } from "@farcaster/miniapp-sdk";
import { formatUnits, encodeFunctionData, parseUnits } from "viem";
import { useSearchParams } from "next/navigation";
import { tierRegistryAbi } from "../contracts/tierRegistryAbi.js";
import axios from "axios";
import LoadingScreen from "./Loading";
import Toast from "./Toast";
import Confetti from "react-confetti";

const TIER_REGISTRY_ADDRESS =
  "0x00000000fc84484d585C3cF48d213424DFDE43FD" as const;
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const EXTRA_FEE_RECIPIENT = "0x21808EE320eDF64c019A6bb0F7E4bFB3d62F06Ec";

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
];

type Profile = {
  fid: number;
  username: string;
  displayName: string;
  bio: string;
  location: string;
  followerCount: number;
  followingCount: number;
  pfp: {
    url: string;
    verified: boolean;
  };
  accountLevel: string;
};

export default function Main() {
  const { isConnected, chain, address } = useAccount();

  const [totalPrice, setTotalPrice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSDKLoaded, setIsSDKLoaded] = useState(false);
  const [context, setContext] = useState<Context.MiniAppContext>();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [isClicked, setIsClicked] = useState(false);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const EXTRA_FEE = parseUnits("0.5", 6); // 0.5 USDC (6 decimals)

  useEffect(() => {
    const load = async () => {
      const context = await sdk.context;
      setContext(context);
      sdk.actions.ready({});
    };
    if (sdk && !isSDKLoaded) {
      setIsSDKLoaded(true);
      load();
      return () => {
        sdk.removeAllListeners();
      };
    }
  }, [isSDKLoaded]);

  const [fid, setFid] = useState<number | undefined>(undefined);
  const [paymentToken, setPaymentToken] = useState<`0x${string}` | null>(null);
  const [tokenDecimals, setTokenDecimals] = useState<number>(6); // USDC has 6 decimals

  // Fetch tier info for tierId=1
  const { data: tierInfoData, error: tierInfoError } = useReadContract({
    address: TIER_REGISTRY_ADDRESS,
    abi: tierRegistryAbi,
    functionName: "tierInfo",
    args: [1],
    chainId: base.id,
  } as const) as {
    data:
      | {
          minDays: bigint;
          maxDays: bigint;
          paymentToken: `0x${string}`;
          tokenPricePerDay: bigint;
          vault: string;
          isActive: boolean;
        }
      | undefined;
    error: Error | null;
  };

  // Fetch token decimals for paymentToken
  const { data: decimalsData, error: decimalsError } = useReadContract({
    address: paymentToken ?? undefined,
    abi: erc20Abi,
    functionName: "decimals",
    chainId: base.id,
  } as const) as { data: number | undefined; error: Error | null };

  // Fetch subscription price for tierId=1, forDays=30
  const {
    data: priceData,
    isLoading: isPriceLoading,
    error: priceError,
  } = useReadContract({
    address: TIER_REGISTRY_ADDRESS,
    abi: tierRegistryAbi,
    functionName: "price",
    args: [1, 30],
    chainId: base.id,
  } as const) as {
    data: bigint | undefined;
    isLoading: boolean;
    error: Error | null;
  };

  // Batch transaction hook
  const {
    sendCalls,
    error: sendCallsError,
    isPending: isTxPending,
    isSuccess: isTxSuccess,
  } = useSendCalls();

  // Update subscription price, payment token, and decimals
  useEffect(() => {
    if (tierInfoError) {
      console.error("Tier info error:", tierInfoError);
      setError(`Failed to fetch tier info: ${tierInfoError.message}`);
    } else if (tierInfoData) {
      console.log("Tier info:", tierInfoData);
      setPaymentToken(tierInfoData.paymentToken);
      if (!tierInfoData.isActive) {
        setError("Tier 1 is not active.");
      } else if (
        tierInfoData.paymentToken.toLowerCase() !== USDC_ADDRESS.toLowerCase()
      ) {
        setError("Tier 1 does not use USDC as payment token.");
      }
    }

    if (decimalsError) {
      console.error("Decimals fetch error:", decimalsError);
      setError(`Failed to fetch token decimals: ${decimalsError.message}`);
    } else if (decimalsData) {
      console.log("Token decimals:", decimalsData);
      setTokenDecimals(decimalsData);
    }

    if (priceError) {
      console.error("Price fetch error:", priceError);
      setError(`Failed to fetch price: ${priceError.message}`);
    } else if (priceData && paymentToken) {
      console.log("Price data:", priceData);
      setTotalPrice(formatUnits(priceData + EXTRA_FEE, tokenDecimals));
    } else {
      console.log("No price data or payment token yet.");
    }
  }, [
    tierInfoData,
    tierInfoError,
    decimalsData,
    decimalsError,
    priceData,
    priceError,
    paymentToken,
    tokenDecimals,
    EXTRA_FEE,
  ]);

  // Handle batch purchase (approve + purchaseTier + transfer extra fee)
  const handleBatchPurchase = async () => {
    setIsClicked(true);
    setTimeout(() => {
      if (!isConnected) {
        setError("Please connect your wallet.");
        setIsClicked(false);
        return;
      }
      if (chain?.id !== base.id) {
        setError("Please switch to the Base network.");
        setIsClicked(false);
        return;
      }
      if (!paymentToken || !priceData) {
        setError("Payment token or price not available.");
        setIsClicked(false);
        return;
      }
      if (!fid || isNaN(Number(fid))) {
        setError("No valid Farcaster ID found.");
        setIsClicked(false);
        return;
      }
      if (
        tierInfoData?.paymentToken.toLowerCase() !==
          USDC_ADDRESS.toLowerCase() ||
        !tierInfoData?.isActive
      ) {
        setError("Invalid tier or payment token.");
        setIsClicked(false);
        return;
      }
      if (isTxSuccess) {
        setIsClicked(false);
        const text =
          context?.user?.fid !== fid
            ? `I Gifted Farcaster Pro to @${profile?.username} for 30 days, with this miniapp by @cashlessman.eth`
            : "I Subscribed to Farcaster Pro for 30 days, with this miniapp by @cashlessman.eth";
        sdk.actions.composeCast({
          text,
          embeds: [`${process.env.NEXT_PUBLIC_URL}`],
        });
        return;
      }
      if (
        userBalance < Number(formatUnits(priceData + EXTRA_FEE, tokenDecimals))
      ) {
        setToastMessage("Insufficient USDC balance");
        setShowToast(true);
        setIsClicked(false);
        return;
      }
      try {
        const totalCost = priceData + EXTRA_FEE;
        sendCalls({
          calls: [
            // Call 1: Approve TierRegistry to spend total USDC (subscription + extra)
            {
              to: USDC_ADDRESS,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [TIER_REGISTRY_ADDRESS, totalCost],
              }),
            },
            // Call 2: Purchase the tier
            {
              to: TIER_REGISTRY_ADDRESS,
              data: encodeFunctionData({
                abi: tierRegistryAbi,
                functionName: "purchaseTier",
                args: [BigInt(fid), 1, 30],
              }),
            },
            // Call 3: Transfer extra 0.5 USDC to your wallet
            {
              to: USDC_ADDRESS,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [EXTRA_FEE_RECIPIENT, EXTRA_FEE],
              }),
            },
          ],
        });
      } catch (err: unknown) {
        setError(
          "Failed to initiate batch purchase: " +
            (err instanceof Error ? err.message : String(err))
        );
        setIsClicked(false);
      }
    }, 500);
  };

  const searchParams = useSearchParams();
  const castFid = searchParams.get("castFid");

  useEffect(() => {
    if (castFid) {
      setFid(Number(castFid));
    } else if (context?.user?.fid) {
      setFid(context.user.fid);
    }
  }, [context, castFid]);

  async function sendMessage(recipientFid: number, message: string) {
    await fetch("/api/dc", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        recipientFid,
        message,
      }),
    });
  }

  useEffect(() => {
    if (isTxSuccess && context?.user?.fid) {
      sdk.haptics.notificationOccurred("success");
      const message =
        context?.user?.fid !== fid
          ? `You Gifted Farcaster Pro to @${profile?.username} for 30 days!`
          : "You Subscribed Farcaster Pro for 30 days!";
      sendMessage(context?.user?.fid, message);
    }
  }, [isTxSuccess]);

  useEffect(() => {
    if (isTxSuccess && context?.user?.fid !== fid) {
      const message = "Gifted you Farcaster Pro for 30 days!";
      sendMessage(Number(fid), `@${context?.user.username} ${message}`);
    }
  }, [isTxSuccess]);

  const errorMessagesSent = useRef(new Set<string>());
  useEffect(() => {
    const sendErrorMessage = async (errorType: string, message: string) => {
      // Avoid sending duplicate error messages
      if (errorMessagesSent.current.has(`${errorType}:${message}`)) return;
      errorMessagesSent.current.add(`${errorType}:${message}`);

      try {
        await sendMessage(268438, `@${context?.user.username}\n\n${message}`);
      } catch (err) {
        console.error(`Failed to send error message for ${errorType}:`, err);
      }
    };

    if (tierInfoError) {
      sendErrorMessage(
        "tierInfo",
        `Failed to fetch tier info: ${tierInfoError.message}`
      );
    }
    if (decimalsError) {
      sendErrorMessage(
        "decimals",
        `Failed to fetch token decimals: ${decimalsError.message}`
      );
    }
    if (priceError) {
      sendErrorMessage("price", `Failed to fetch price: ${priceError.message}`);
    }
    if (sendCallsError) {
      sendErrorMessage(
        "sendCalls",
        `Batch transaction failed: ${sendCallsError.message}`
      );
    }
    if (error) {
      sendErrorMessage("general", error);
    }
  }, [
    tierInfoError,
    decimalsError,
    priceError,
    sendCallsError,
    error,
    context?.user?.fid,
    castFid,
    context?.user.username,
  ]);
  interface ApiResponse {
    expires_at: number;
  }

  const [data, setData] = useState<ApiResponse | null>(null);

  const proStatus = useCallback(async (fid: string) => {
    try {
      const response = await fetch(`/api/proStatus?fid=${fid}`);
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const responseData = await response.json();

      if (responseData) {
        setData({
          expires_at: responseData.expires_at,
        });
      } else {
        throw new Error("Invalid response structure");
      }
    } catch (err) {
      console.error("Error fetching pro status", err);
    }
  }, []);

  useEffect(() => {
    if (fid) {
      proStatus(fid.toString());
      fetchProfile(fid);
    }
  }, [fid, proStatus]);

  function getTimeUntil(timestamp: number): string {
    const now = new Date();
    const future = new Date(timestamp * 1000);

    if (future <= now) {
      return "No active subscription";
    }

    let years = 0;
    let months = 0;
    let days = 0;

    const temp = new Date(now);

    // Count years
    while (
      new Date(temp.getFullYear() + 1, temp.getMonth(), temp.getDate()) <=
      future
    ) {
      temp.setFullYear(temp.getFullYear() + 1);
      years++;
    }

    // Count months
    while (
      new Date(temp.getFullYear(), temp.getMonth() + 1, temp.getDate()) <=
      future
    ) {
      temp.setMonth(temp.getMonth() + 1);
      months++;
    }

    // Remaining ms
    let diffTime = future.getTime() - temp.getTime();
    days = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    // Subtract days in ms
    diffTime -= days * 24 * 60 * 60 * 1000;

    // If less than a day, show hours/minutes/seconds
    const hours = Math.floor(diffTime / (1000 * 60 * 60));
    diffTime -= hours * 60 * 60 * 1000;

    const minutes = Math.floor(diffTime / (1000 * 60));
    diffTime -= minutes * 60 * 1000;

    const seconds = Math.floor(diffTime / 1000);

    const parts: string[] = [];
    if (years > 0) parts.push(`${years} year${years > 1 ? "s" : ""}`);
    if (months > 0) parts.push(`${months} month${months > 1 ? "s" : ""}`);
    if (days > 0) parts.push(`${days} day${days > 1 ? "s" : ""}`);

    if (years === 0 && months === 0 && days === 0) {
      if (hours > 0) parts.push(`${hours} hour${hours > 1 ? "s" : ""}`);
      if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
      if (seconds > 0) parts.push(`${seconds} second${seconds > 1 ? "s" : ""}`);
    }

    return parts.length > 0
      ? `Expires in ${parts.join(", ")}`
      : "No active subscription";
  }

  async function fetchProfile(fid: number) {
    try {
      setLoading(true);
      const res = await fetch(`/api/profile?fid=${fid}`);
      const data = await res.json();
      setProfile(data);
    } catch (err) {
      console.error("Error fetching profile:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (context && !context?.client.added && isTxSuccess) {
      sdk.actions.addMiniApp();
    }
  }, [context, context?.client.added, isTxSuccess]);

  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  const { data: balance } = useBalance({
    address,
    token: USDC_ADDRESS,
    chainId: base.id,
  });

  const userBalance = balance ? Number(formatUnits(balance.value, 6)) : 0;

  if (!context)
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="flex flex-col items-center justify-center text-white text-2xl p-4">
          <p className="flex items-center justify-center text-center">
            You need to access this mini app from inside a farcaster client
          </p>
          <div
            className="flex items-center justify-center text-center bg-indigo-800 p-3 rounded-lg mt-4 cursor-pointer"
            onClick={() =>
              window.open(
                "https://farcaster.xyz/miniapps/RXyuECl7a0po/farcaster-pro",
                "_blank"
              )
            }
          >
            Open in Farcaster
          </div>
        </div>
      </div>
    );

  if (loading) return <LoadingScreen />;

  return (
    <div
      style={{
        paddingTop: context?.client.safeAreaInsets?.top ?? 0,
        paddingBottom: context?.client.safeAreaInsets?.bottom ?? 0,
        paddingLeft: context?.client.safeAreaInsets?.left ?? 0,
        paddingRight: context?.client.safeAreaInsets?.right ?? 0,
      }}
      className="h-screen bg-slate-900 flex flex-col items-center justify-center"
    >
      {!isConnected ? (
        <Connect />
      ) : chainId !== base.id ? (
        <Switch />
      ) : (
        <div className="flex flex-col items-center justify-center w-full">
          <header className="flex-none fixed top-0 left-0 w-full">
            <Search />
          </header>
          {showToast && (
            <Toast message={toastMessage} onClose={() => setShowToast(false)} />
          )}
          <div className="max-w-sm border rounded-2xl shadow-md p-4 bg-[#16101e] text-white">
            <div className="flex items-center space-x-4">
              <div className="relative">
                <img
                  src={profile?.pfp?.url ?? "https://farcaster.xyz/avatar.png"}
                  alt={profile?.displayName}
                  className="w-16 h-16 rounded-full border"
                />
                {profile?.accountLevel && (
                  <div className="absolute bottom-0 right-0 bg-white rounded-full p-0.5">
                    <img
                      src="/verified.svg"
                      alt="Verified"
                      className="w-3.5 h-3.5"
                    />
                  </div>
                )}
              </div>

              <div>
                <h2 className="text-lg font-bold">{profile?.displayName}</h2>
                <p className="text-gray-300">@{profile?.username}</p>
                <span
                  className="inline-flex items-center gap-1 text-xs font-semibold bg-purple-100 rounded-xl px-1.5 py-0.5"
                  style={{
                    color:
                      new Date(
                        data?.expires_at ? data?.expires_at * 1000 : Infinity
                      ) <= new Date()
                        ? "#dc2626"
                        : "#7c3aed",
                  }}
                >
                  <img
                    src="/verified.svg"
                    alt="Verified"
                    className="w-3.5 h-3.5"
                  />

                  {data?.expires_at == null
                    ? "Loading subscription details"
                    : getTimeUntil(data?.expires_at)}
                </span>
              </div>
            </div>

            {/* Bio */}
            {profile?.bio && (
              <p className="mt-3 text-sm whitespace-pre-line">{profile.bio}</p>
            )}

            {/* Location */}
            {profile?.location && (
              <p className="mt-2 text-xs text-gray-600">
                📍 {profile?.location}
              </p>
            )}

            {/* Stats */}
            <div className="flex space-x-6 mt-3 text-sm">
              <p>
                <span className="font-semibold">{profile?.followingCount}</span>{" "}
                Following
              </p>
              <p>
                <span className="font-semibold">{profile?.followerCount}</span>{" "}
                Followers
              </p>
              <p>
                <span className="font-semibold">{fid ?? "loading"}</span> FID
              </p>
            </div>

            <div className="mt-4">
              <button
                onClick={handleBatchPurchase}
                disabled={
                  isTxPending ||
                  !isConnected ||
                  chain?.id !== base.id ||
                  !paymentToken ||
                  !priceData
                }
                className="text-white text-center py-2 rounded-xl font-semibold text-lg shadow-lg relative overflow-hidden transform transition-all duration-200 hover:scale-110 active:scale-95 flex items-center justify-center gap-2 mx-auto"
                style={{
                  background:
                    "linear-gradient(90deg, #8B5CF6, #7C3AED, #A78BFA, #8B5CF6)",
                  backgroundSize: "300% 100%",
                  animation: "gradientAnimation 3s infinite ease-in-out",
                }}
              >
                <div
                  className={`absolute inset-0 bg-[#38BDF8] transition-all duration-500 ${
                    isClicked ? "scale-x-100" : "scale-x-0"
                  }`}
                  style={{ transformOrigin: "center" }}
                ></div>
                <style>{`
            @keyframes gradientAnimation {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
            }
          `}</style>
                <div className="flex flex-row gap-2 px-5">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-6 h-6 relative z-10"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
                    />
                  </svg>{" "}
                  <span className="relative z-10">
                    {isTxPending
                      ? "Processing..."
                      : isTxSuccess
                      ? context?.user?.fid !== fid
                        ? "Gifted!, Cast it!"
                        : "Subscribed!, Cast it!"
                      : profile?.accountLevel
                      ? context?.user?.fid !== fid
                        ? "Extend Pro by 30 days (Gift)"
                        : "Extend Pro by 30 days"
                      : context?.user?.fid !== fid
                      ? "Gift Pro for 30 days"
                      : "Subscribe Pro for 30 days"}
                  </span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-6 h-6 relative z-10"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
                    />
                  </svg>{" "}
                </div>
              </button>
              <div className="text-xs text-center mt-2">
                (includes maintence fee)
              </div>
            </div>
          </div>
          <div className="text-white text-center mt-3 font-semibold text-sm">
            Price:{" "}
            {isPriceLoading
              ? "Loading..."
              : totalPrice
              ? `$${Number(totalPrice).toFixed(2)}`
              : "N/A"}
            /month
          </div>{" "}
          {userBalance < Number(totalPrice) && (
            <p className="text-red-700 text-center mt-3 font-semibold text-sm">
              Your Balance: {userBalance.toFixed(2)} USDC on Base - Insufficient
            </p>
          )}
          {tierInfoError && <ErrorMessage />}
          {decimalsError && <ErrorMessage />}
          {priceError && <ErrorMessage />}
          <div className="flex gap-3"></div>
          {isTxSuccess && <Confetti />}
          {error && <ErrorMessage />}
          <footer className="flex-none fixed bottom-0 left-0 w-full p-4 text-center text-white">
           {!isTxSuccess && <div>
              {" "}
              Please use farcaster wallet on Mobile <br /> for better
              experience.
            </div>} 
            <button
              className="bg-[#7C3AED] text-white px-4 py-2 rounded-lg hover:bg-[#38BDF8] transition cursor-pointer font-semibold w-1/2 mt-2"
              onClick={() => sdk.actions.viewProfile({ fid: 268438 })}
            >
              Developer Profile
            </button>
          </footer>
        </div>
      )}
    </div>
  );

  function Connect() {
    const { connect } = useConnect();
    const [isClicked, setIsClicked] = useState(false);

    const handleConnect = () => {
      setIsClicked(true);
      setTimeout(() => {
        connect({ connector: config.connectors[0] });
      }, 500);

      setTimeout(() => setIsClicked(false), 500);
    };

    return (
      <div className="flex flex-col mt-2">
        <button
          onClick={handleConnect}
          className="text-white text-center py-2 rounded-xl font-semibold text-lg shadow-lg relative overflow-hidden transform transition-all duration-200 hover:scale-110 active:scale-95 flex items-center justify-center gap-2"
          style={{
            background:
              "linear-gradient(90deg, #8B5CF6, #7C3AED, #A78BFA, #8B5CF6)",
            backgroundSize: "300% 100%",
            animation: "gradientAnimation 3s infinite ease-in-out",
          }}
        >
          <div
            className={`absolute inset-0 bg-[#38BDF8] transition-all duration-500 ${
              isClicked ? "scale-x-100" : "scale-x-0"
            }`}
            style={{ transformOrigin: "center" }}
          ></div>
          <style>{`
              @keyframes gradientAnimation {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
              }
            `}</style>
          <div className="flex flex-row gap-2 px-5">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-6 h-6 relative z-10"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
              />
            </svg>{" "}
            <span className="relative z-10">Connect Wallet</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-6 h-6 relative z-10"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
              />
            </svg>{" "}
          </div>
        </button>
      </div>
    );
  }

  function Switch() {
    const [isClicked, setIsClicked] = useState(false);

    const handleConnect = () => {
      setIsClicked(true);
      setTimeout(() => {
        switchChain({ chainId: base.id });
      }, 500);

      setTimeout(() => setIsClicked(false), 500);
    };

    return (
      <div className="flex flex-col mt-2">
        <button
          onClick={handleConnect}
          className="text-white text-center py-2 rounded-xl font-semibold text-lg shadow-lg relative overflow-hidden transform transition-all duration-200 hover:scale-110 active:scale-95 flex items-center justify-center gap-2"
          style={{
            background:
              "linear-gradient(90deg, #8B5CF6, #7C3AED, #A78BFA, #8B5CF6)",
            backgroundSize: "300% 100%",
            animation: "gradientAnimation 3s infinite ease-in-out",
          }}
        >
          <div
            className={`absolute inset-0 bg-[#38BDF8] transition-all duration-500 ${
              isClicked ? "scale-x-100" : "scale-x-0"
            }`}
            style={{ transformOrigin: "center" }}
          ></div>
          <style>{`
              @keyframes gradientAnimation {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
              }
            `}</style>
          <div className="flex flex-row gap-2 px-5">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-6 h-6 relative z-10"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
              />
            </svg>{" "}
            <span className="relative z-10">Switch to Base</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-6 h-6 relative z-10"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
              />
            </svg>{" "}
          </div>
        </button>
      </div>
    );
  }

  function ErrorMessage() {
    return (
      <div className="flex flex-col items-center">
        <p className="text-red-500 mb-2 text-center font-semibold">
          There was an error.
          <br /> Please close and open the miniapp again.
        </p>
        <button
          className="bg-[#7C3AED] text-white px-4 py-2 rounded-lg hover:bg-[#38BDF8] transition cursor-pointer font-semibold w-full mt-2"
          onClick={() => sdk.actions.close()}
        >
          Close Miniapp
        </button>
      </div>
    );
  }

  function Search() {
    const [searchValue, setSearchValue] = useState("");

    const usernameToFid = useCallback(async (searchValue: string) => {
      try {
        const username = searchValue.includes("@")
          ? searchValue.replace("@", "")
          : searchValue;

        const apiUrl = `${process.env.NEXT_PUBLIC_HubUrl}/v1/userNameProofByName?name=${username}`;
        const response = await axios.get(apiUrl);
        const searchFid = response.data.fid;

        setFid(searchFid);
      } catch {
        setToastMessage("Please enter a valid username");
        setShowToast(true);
        // console.error('Error fetching data:', error);
      }
    }, []);
    return (
      <div className="absolute top-0 flex flex-row w-full items-center justify-between bg-slate-900 p-2 border-b border-white/20 shadow-md">
        <div className="flex items-center gap-3">
          <input
            className="w-[220px] p-2 bg-white/20 text-white text-base rounded-xl border border-white/30 focus:outline-none focus:ring-2 focus:ring-[#FFDEAD] placeholder-white/80"
            type="text"
            placeholder="Search a username to Gift"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                usernameToFid(searchValue);
              }
            }}
          />
          <div
            className="bg-white/20 hover:bg-white/30 transition p-2 rounded-xl flex items-center justify-center cursor-pointer"
            onClick={() => usernameToFid(searchValue)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="white"
              className="w-6 h-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
              />
            </svg>
          </div>
        </div>

        <div
          className="bg-white/20 hover:bg-white/30 transition p-2 rounded-xl flex items-center justify-center cursor-pointer"
          onClick={() =>
            sdk.actions.viewCast({
              hash: "0xaba31427ae981da207271a59e9e42aebd3c969af",
            })
          }
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="white"
            viewBox="0 0 24 24"
            className="w-6 h-6"
          >
            <path
              fillRule="evenodd"
              d="M12 2C6.477 2 2 6.478 2 12s4.477 10 10 10 10-4.478 10-10S17.523 2 12 2Zm0 5a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1Zm0 10.25a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z"
              clipRule="evenodd"
            />
          </svg>
        </div>

        <div
          className="bg-white/20 hover:bg-white/30 transition p-2 rounded-xl flex items-center justify-center cursor-pointer"
          onClick={() =>
            sdk.actions.composeCast({
              text: `Subscribe and Gift Farcaster Pro for 30 days with this miniapp by @cashlessman.eth`,
              embeds: [`${process.env.NEXT_PUBLIC_URL}`],
            })
          }
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="white"
            className="w-6 h-6"
          >
            <path
              fillRule="evenodd"
              d="M15.75 4.5a3 3 0 1 1 .825 2.066l-8.421 4.679a3.002 3.002 0 0 1 0 1.51l8.421 4.679a3 3 0 1 1-.729 1.31l-8.421-4.678a3 3 0 1 1 0-4.132l8.421-4.679a3 3 0 0 1-.096-.755Z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      </div>
    );
  }
}
